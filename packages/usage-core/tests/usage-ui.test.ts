import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  fetchUsage,
  useUsage,
  type Request,
} from '../../../apps/desktop/src/usage/useUsage.js';
import {
  selectUsage,
  usageState,
} from '../../../apps/desktop/src/usage/viewModel.js';
import type { UsageItem } from '../../../apps/desktop/src/usage/UsageTab.js';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
import { handleRequest } from '../src/service/protocol.js';
import { testTempDir } from './test-temp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const item = (
  agent: string,
  input: number,
  timestamp = '2025-01-01T00:00:00Z',
): UsageItem => ({
  agent,
  input,
  timestamp,
  model: 'model',
  session: 'session',
  output: 2,
  cached: 1,
  reasoning: 1,
  warnings: [],
});

describe('usage view data', () => {
  it('distinguishes loading, errors, source setup, empty filters and data', () => {
    expect(usageState(true, undefined, 0, 0)).toBe('loading');
    expect(usageState(false, 'error', 0, 0)).toBe('error');
    expect(usageState(false, undefined, 0, 0)).toBe('needs-source');
    expect(usageState(false, undefined, 1, 0)).toBe('empty');
    expect(usageState(false, undefined, 1, 1)).toBe('ready');
  });
  it('filters by agent, model, day and session and sorts numeric columns', () => {
    const records = [
      item('codex', 10),
      item('codex', 3),
      item('grok-build', 5, '2025-01-02T00:00:00Z'),
    ];
    const filters = {
      agent: 'codex',
      model: 'model',
      day: '2025-01-01',
      session: 'session',
    };
    expect(
      selectUsage(records, filters, 'input', false).map((row) => row.input),
    ).toEqual([3, 10]);
    expect(
      selectUsage(records, { ...filters, session: 'missing' }, 'input', true),
    ).toEqual([]);
    expect(
      selectUsage(records, filters, 'input', true).map((row) => row.input),
    ).toEqual([10, 3]);
  });

  it('loads every backend page and preserves source warnings', async () => {
    const first = Array.from({ length: 500 }, () => item('codex', 1));
    const request = vi.fn(
      async (_command: string, args?: Record<string, unknown>) => ({
        result: {
          status: 'partial',
          totalRecords: 501,
          offset: args?.offset,
          snapshotId: 'a'.repeat(64),
          records: args?.offset === 0 ? first : [item('codex', 2)],
          warnings: ['partial scan'],
        },
      }),
    ) as unknown as Request;
    const result = await fetchUsage(
      [{ id: 'source', agent: 'codex', name: 'logs', coveredBy: null }],
      request,
      () => true,
    );
    expect(result.records).toHaveLength(501);
    expect(result.warnings).toContain('codex: partial scan');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps healthy sources when another source fails midway and refreshes after recovery', async () => {
    const sources = [
      { id: 'first', agent: 'codex', name: 'first', coveredBy: null },
      { id: 'lost', agent: 'codex', name: 'moved', coveredBy: null },
      { id: 'other', agent: 'grok-build', name: 'other', coveredBy: null },
    ];
    let recovered = false;
    const request = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const offset = args?.offset;
      const lost = args?.id === 'lost';
      if (lost && offset === 1 && !recovered)
        throw new Error('Synthetic private path');
      return {
        result: {
          status: lost ? 'partial' : 'ok',
          totalRecords: lost ? 2 : 1,
          offset,
          snapshotId: 'a'.repeat(64),
          records: [item(args?.id === 'other' ? 'grok-build' : 'codex', lost ? 99 : 10)],
          warnings: lost ? ['source page warning'] : [],
        },
      };
    }) as unknown as Request;
    const partial = await fetchUsage(sources, request, () => true);
    expect(partial).toEqual({
      records: [item('codex', 10), item('grok-build', 10)],
      warnings: ['codex (moved): zdroj sa nepodarilo načítať.'],
      partial: true,
    });
    recovered = true;
    expect((await fetchUsage(sources, request, () => true)).records.map((row) => row.input))
      .toEqual([10, 99, 99, 10]);
  });

  it('isolates known sidecar source errors and rejects a total failure or invalid envelope', async () => {
    const unavailable = { id: 'lost', agent: 'codex', name: 'moved', coveredBy: null };
    const healthy = { id: 'other', agent: 'grok-build', name: 'other', coveredBy: null };
    const request = vi.fn(async (_command: string, args?: Record<string, unknown>) =>
      args?.id === 'lost'
        ? { version: 1, error: 'INVALID_OR_UNREADABLE' }
        : { result: { status: 'ok', totalRecords: 1, offset: 0, snapshotId: 'b'.repeat(64),
          records: [item('grok-build', 10)], warnings: [] } },
    ) as unknown as Request;
    expect(await fetchUsage([unavailable, healthy], request, () => true)).toMatchObject({
      records: [item('grok-build', 10)],
      partial: true,
    });
    await expect(fetchUsage([unavailable], request, () => true)).rejects.toThrow('žiadny zdroj');
    const invalid = vi.fn(async () => ({ version: 1, error: 'unexpected response' })) as unknown as Request;
    await expect(fetchUsage([unavailable, healthy], invalid, () => true)).rejects.toThrow('Neplatná odpoveď');
  });

  it('removes only the selected saved source and refreshes the remaining sources', async () => {
    const remaining = { id: 'other', agent: 'grok-build', name: 'other', coveredBy: null };
    const invoke = vi.fn(async (command: string) => {
      if (command === 'usage_list_sources') return [remaining];
      if (command === 'usage_scan')
        return { result: { status: 'ok', totalRecords: 0, offset: 0, snapshotId: 'a'.repeat(64), records: [], warnings: [] } };
    });
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
    let removeSource: ReturnType<typeof useUsage>['removeSource'] | undefined;
    function CaptureAction() {
      ({ removeSource } = useUsage());
      return null;
    }
    try {
      renderToStaticMarkup(createElement(CaptureAction));
      expect(removeSource).toBeTypeOf('function');
      await removeSource?.('lost');
      expect(invoke.mock.calls).toEqual([
        ['usage_remove_source', { id: 'lost' }, undefined],
        ['usage_list_sources', {}, undefined],
        ['usage_scan', { id: 'other', force: false, offset: 0 }, undefined],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a source changed between pages even when its record count is unchanged', async () => {
    const request = vi.fn(async (_command: string, args?: Record<string, unknown>) => ({
      result: {
        status: 'ok', totalRecords: 501, offset: args?.offset,
        snapshotId: (args?.offset === 0 ? 'a' : 'b').repeat(64),
        records: args?.offset === 0 ? Array.from({ length: 500 }, () => item('codex', 1)) : [item('codex', 2)],
        warnings: [],
      },
    })) as unknown as Request;
    await expect(fetchUsage([{ id: 'source', agent: 'codex', name: 'logs', coveredBy: null }], request, () => true))
      .rejects.toThrow('počas stránkovania zmenil');
  });

  it('scans repeated source identities once and keeps every event from the surviving source', async () => {
    const request = vi.fn(async () => ({
      result: { status: 'ok', totalRecords: 2, offset: 0, snapshotId: 'a'.repeat(64),
        records: [item('codex', 10), item('codex', 10)], warnings: [] },
    })) as unknown as Request;
    const result = await fetchUsage([
      { id: 'a', agent: 'codex', name: 'same', coveredBy: null },
      { id: 'b', agent: 'codex', name: 'same', coveredBy: 'a' },
    ], request, () => true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.records).toHaveLength(2);
    expect(result.records.reduce((sum, row) => sum + row.input, 0)).toBe(20);
    expect(usageCsv(result.records).trim().split('\n')).toHaveLength(3);
  });

  it('does not count a directory and its covered file twice, even if the file comes first', async () => {
    const dir = await testTempDir('source-overlap-');
    const folder = join(dir, 'sessions');
    const file = join(folder, 'one.jsonl');
    const cachePath = join(dir, 'cache.sqlite');
    await mkdir(folder);
    const event = (total: number) => JSON.stringify({
      timestamp: '2025-01-01T00:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
      } },
    });
    await writeFile(file, [JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic' } }), event(10), event(20), ''].join('\n'));
    const request = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const path = args?.id === 'folder' ? folder : file;
      return handleRequest({ version: 1, requestId: 'synthetic', method: 'scan',
        params: { agent: 'codex', path, cachePath, offset: args?.offset } });
    }) as unknown as Request;
    const result = await fetchUsage([
      { id: 'file', agent: 'codex', name: 'one', coveredBy: 'folder' },
      { id: 'folder', agent: 'codex', name: 'sessions', coveredBy: null },
      { id: 'folder-again', agent: 'codex', name: 'sessions', coveredBy: 'folder' },
    ], request, () => true);
    expect(request).toHaveBeenCalledTimes(1);
    // Both separate cumulative states have identical visible last-usage fields.
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual(result.records[1]);
    expect(result.records.reduce((sum, row) => sum + row.input, 0)).toBe(20);
  });

  it('retains identical-looking events in distinct uncovered sources', async () => {
    const request = vi.fn(async () => ({
      result: { status: 'ok', totalRecords: 1, offset: 0, snapshotId: 'b'.repeat(64),
        records: [item('grok-build', 10)], warnings: [] },
    })) as unknown as Request;
    const result = await fetchUsage([
      { id: 'a', agent: 'grok-build', name: 'one', coveredBy: null },
      { id: 'b', agent: 'grok-build', name: 'two', coveredBy: null },
    ], request, () => true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.records).toHaveLength(2);
    expect(result.records.reduce((sum, row) => sum + row.input, 0)).toBe(20);
  });

  it('rejects missing, inconsistent or cyclic source coverage', async () => {
    const request = vi.fn() as unknown as Request;
    const source = { id: 'a', agent: 'codex', name: 'logs', coveredBy: 'b' };
    await expect(fetchUsage([source], request, () => true)).rejects.toThrow('prekrytie');
    await expect(fetchUsage([source, { ...source, id: 'b', coveredBy: 'a' }], request, () => true)).rejects.toThrow('prekrytie');
    await expect(fetchUsage([{ ...source, coveredBy: undefined } as unknown as typeof source], request, () => true)).rejects.toThrow('bezpečné');
    expect(request).not.toHaveBeenCalled();
  });

  it('handles empty sources, cancellation and malformed pages', async () => {
    const request = vi.fn() as unknown as Request;
    expect(await fetchUsage([], request, () => true)).toEqual({
      records: [],
      warnings: [],
      partial: false,
    });
    expect(
      await fetchUsage(
        [{ id: 'x', agent: 'codex', name: 'logs', coveredBy: null }],
        request,
        () => false,
      ),
    ).toEqual({ records: [], warnings: [], partial: false });
    const invalid = vi.fn(async () => ({
      result: { totalRecords: 2, records: [], warnings: [] },
    })) as unknown as Request;
    await expect(
      fetchUsage(
        [{ id: 'x', agent: 'codex', name: 'logs', coveredBy: null }],
        invalid,
        () => true,
      ),
    ).rejects.toThrow();
  });
});
