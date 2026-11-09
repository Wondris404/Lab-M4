import { expect, it } from 'vitest';
import {
  buildUsageDashboard,
  metricValue,
  periodStart,
} from '../../../apps/desktop/src/usage/dashboard';
import type { UsageItem } from '../../../apps/desktop/src/usage/UsageTab';

it('keeps chart buckets and totals aligned without double-counting cache or inventing prices', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const start = periodStart(7, now);
  const record = (
    time: number,
    agent: string,
    costUsd?: number,
  ): UsageItem => ({
    agent,
    timestamp: new Date(time).toISOString(),
    session: 'same-id',
    model: 'model',
    input: 10,
    cached: 7,
    output: 3,
    reasoning: 1,
    warnings: [],
    ...(costUsd !== undefined && { costUsd }),
  });
  const dashboard = buildUsageDashboard(
    [
      record(start - 1, 'codex'),
      record(start, 'codex'),
      record(now, 'opencode', 0),
      record(now + 1, 'codex'),
    ],
    7,
    now,
  );
  expect(dashboard.buckets).toHaveLength(7);
  expect(dashboard.buckets[1]?.byAgent.size).toBe(0);
  expect(dashboard.total.sessions.size).toBe(2);
  expect(dashboard.total.cached).toBe(14);
  expect(metricValue(dashboard.total, 'tokens')).toBe(26);
  expect(metricValue(dashboard.agents.get('codex')!, 'cost')).toBeNull();
  expect(metricValue(dashboard.agents.get('opencode')!, 'cost')).toBe(0);
});
