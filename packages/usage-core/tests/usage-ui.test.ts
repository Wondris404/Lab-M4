import { describe, expect, it, vi } from 'vitest';
import {
  fetchUsage,
  loadUsage,
  type Request,
  type Source,
} from '../../../apps/desktop/src/usage/useUsage.js';
import {
  selectUsage,
  usageState,
} from '../../../apps/desktop/src/usage/viewModel.js';
import type { UsageItem } from '../../../apps/desktop/src/usage/UsageTab.js';

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
const source = (id: string, overrides: Partial<Source> = {}): Source => ({
  id, agent: 'codex', name: 'logs', automatic: false, enabled: true, ...overrides,
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
      [source('source')],
      request,
      () => true,
    );
    expect(result.records).toHaveLength(501);
    expect(result.warnings).toContain('codex: partial scan');
    expect(request).toHaveBeenCalledTimes(2);
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
    const result = await fetchUsage([source('source')], request, () => true);
    expect(result.records).toEqual([]);
    expect(result.warnings[0]).toContain('počas stránkovania zmenil');
  });

  it('handles empty sources, cancellation and malformed pages', async () => {
    const request = vi.fn() as unknown as Request;
    expect(await fetchUsage([], request, () => true)).toEqual({
      records: [],
      warnings: [],
    });
    expect(
      await fetchUsage(
        [source('x')],
        request,
        () => false,
      ),
    ).toEqual({ records: [], warnings: [] });
    const invalid = vi.fn(async () => ({
      result: { totalRecords: 2, records: [], warnings: [] },
    })) as unknown as Request;
    expect((await fetchUsage([source('x')], invalid, () => true)).warnings[0])
      .toContain('Neplatná odpoveď');
  });

  it('scans discovered sources on opening and skips disabled and covered sources', async () => {
    const sources = [
      source('auto-codex', { automatic: true }),
      source('manual-file', { coveredBy: 'auto-codex' }),
      source('auto-grok-build', { agent: 'grok-build', automatic: true, enabled: false }),
      source('auto-opencode', { agent: 'opencode', automatic: true }),
    ];
    const request = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'usage_list_sources') return sources;
      if (args?.saved) return null;
      if (args?.id === 'auto-opencode') throw new Error('Databáza nedostupná');
      return { result: {
        status: 'ok', totalRecords: 1, offset: 0, snapshotId: 'a'.repeat(64),
        records: [item('codex', 10)], warnings: [],
      } };
    });
    const result = await loadUsage(request as unknown as Request, () => true);
    expect(request.mock.calls.filter(([, args]) => !args?.saved).map(([command, args]) => [command, args?.id])).toEqual([
      ['usage_list_sources', undefined], ['usage_scan', 'auto-codex'], ['usage_scan', 'auto-opencode'],
    ]);
    expect(result.sources).toEqual(sources);
    expect(result.records).toEqual([item('codex', 10)]);
    expect(result.warnings[0]).toContain('Databáza nedostupná');
  });

  it('shows saved results before background refresh and retains a failed source', async () => {
    const sources = [source('first'), source('second', { agent: 'opencode' })];
    const steps: string[] = [];
    const request = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'usage_list_sources') return sources;
      if (!args?.saved) steps.push(`refresh:${args?.id}`);
      if (!args?.saved && args?.id === 'second') throw new Error('Source offline');
      const row = args?.id === 'second' ? item('opencode', 20) : item('codex', args?.saved ? 10 : 15);
      return { result: {
        status: 'ok', totalRecords: 1, offset: 0, snapshotId: 'a'.repeat(64),
        records: [row], warnings: [],
      } };
    });
    const result = await loadUsage(request as unknown as Request, () => true, undefined, (records) => {
      steps.push(records.map((record) => record.input).join(','));
    });
    expect(steps).toEqual(['10,20', 'refresh:first', '15,20', 'refresh:second', '15,20']);
    expect(result.records.map((record) => record.input)).toEqual([15, 20]);
    expect(result.warnings[0]).toContain('posledné uložené údaje');
  });

  it('scans a covered manual source when its covering source fails', async () => {
    const request = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      if (args?.id === 'auto-codex') throw new Error('Source unavailable');
      return { result: {
        status: 'ok', totalRecords: 1, offset: 0, snapshotId: 'a'.repeat(64),
        records: [item('codex', 10)], warnings: [],
      } };
    });
    const result = await fetchUsage([
      source('auto-codex', { automatic: true }), source('file', { coveredBy: 'auto-codex' }),
    ], request as unknown as Request, () => true);
    expect(result.records).toEqual([item('codex', 10)]);
    expect(result.warnings).toHaveLength(1);
  });
});
