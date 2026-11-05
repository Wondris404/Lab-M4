import { describe, expect, it, vi } from 'vitest';
import {
  fetchUsage,
  type Request,
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
          records: args?.offset === 0 ? first : [item('codex', 2)],
          warnings: ['partial scan'],
        },
      }),
    ) as unknown as Request;
    const result = await fetchUsage(
      [{ id: 'source', agent: 'codex', name: 'logs' }],
      request,
      () => true,
    );
    expect(result.records).toHaveLength(501);
    expect(result.warnings).toContain('codex: partial scan');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('handles empty sources, cancellation and malformed pages', async () => {
    const request = vi.fn() as unknown as Request;
    expect(await fetchUsage([], request, () => true)).toEqual({
      records: [],
      warnings: [],
    });
    expect(
      await fetchUsage(
        [{ id: 'x', agent: 'codex', name: 'logs' }],
        request,
        () => false,
      ),
    ).toEqual({ records: [], warnings: [] });
    const invalid = vi.fn(async () => ({
      result: { totalRecords: 2, records: [], warnings: [] },
    })) as unknown as Request;
    await expect(
      fetchUsage(
        [{ id: 'x', agent: 'codex', name: 'logs' }],
        invalid,
        () => true,
      ),
    ).rejects.toThrow();
  });
});
