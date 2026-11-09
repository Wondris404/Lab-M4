import type { UsageItem } from './UsageTab';
import { addUsageTokens } from './viewModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const PERIODS = [
  [1, '24 hod.'],
  [7, '7 dní'],
  [30, '30 dní'],
  [90, '90 dní'],
  ['all', 'Všetko'],
] as const;
export type UsagePeriod = (typeof PERIODS)[number][0];
export type UsageMetric = 'tokens' | 'cost';

const PROVIDERS: Record<string, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'var(--usage-codex)' },
  'grok-build': { label: 'Grok Build', color: 'var(--usage-grok)' },
  opencode: { label: 'OpenCode', color: 'var(--usage-opencode)' },
  antigravity: { label: 'Antigravity', color: 'var(--usage-other)' },
};

export function providerInfo(agent: string) {
  return PROVIDERS[agent] ?? { label: agent, color: 'var(--usage-other)' };
}

export function usageDay(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dayStart(value: number, delta = 0) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return date.getTime();
}

export function periodStart(period: UsagePeriod, now: number) {
  if (period === 'all') return -Infinity;
  return period === 1 ? now - DAY : dayStart(now, 1 - period);
}

function totals() {
  return { input: 0, output: 0, cached: 0, cost: 0, priced: 0, count: 0, tokens: 0 as number | undefined };
}

type Totals = ReturnType<typeof totals>;
type Group = Totals & { sessions: Set<string> };
type Model = Totals & { model: string; agent: string };

function add(target: Totals, record: UsageItem) {
  target.tokens = addUsageTokens(target.tokens, record);
  target.input += record.input;
  target.output += record.output;
  target.cached += record.cached;
  target.count++;
  if (record.costUsd !== undefined) {
    target.cost += record.costUsd;
    target.priced++;
  }
}

export function metricValue(
  totals: Totals,
  metric: UsageMetric,
): number | null {
  if (metric === 'tokens') return totals.tokens ?? null;
  return totals.priced ? totals.cost : totals.count ? null : 0;
}

export function buildUsageDashboard(
  records: UsageItem[],
  period: UsagePeriod,
  now: number,
) {
  const dated = records.map((record) => ({
    record,
    time: Date.parse(record.timestamp),
  }));
  const hourly = period === 1;
  const first = dated.reduce(
    (earliest, row) => (row.time < earliest ? row.time : earliest),
    now,
  );
  const start = period === 'all' ? dayStart(first) : periodStart(period, now);
  const step =
    !hourly && (now - start) / DAY > 180
      ? Math.ceil((now - start) / DAY / 180)
      : 1;
  const buckets: { time: number; byAgent: Map<string, Totals> }[] = [];
  for (
    let time = hourly ? Math.floor(start / HOUR) * HOUR : start;
    time <= now;
    time = hourly ? time + HOUR : dayStart(time, step)
  ) {
    buckets.push({ time, byAgent: new Map() });
  }

  const total = { ...totals(), sessions: new Set<string>() };
  const agents = new Map<string, Group>();
  const models = new Map<string, Model>();
  const ordered = dated
    .filter(({ time }) => time >= start && time <= now)
    .sort((a, b) => a.time - b.time);
  let bucketIndex = 0;
  for (const { record, time } of ordered) {
    while (
      bucketIndex + 1 < buckets.length &&
      buckets[bucketIndex + 1]!.time <= time
    )
      bucketIndex++;
    const bucket = buckets[bucketIndex]!;
    const point = bucket.byAgent.get(record.agent) ?? totals();
    add(point, record);
    bucket.byAgent.set(record.agent, point);
    const agent = agents.get(record.agent) ?? {
      ...totals(),
      sessions: new Set<string>(),
    };
    add(agent, record);
    if (record.sessionKnown !== false) agent.sessions.add(record.session);
    agents.set(record.agent, agent);
    const key = JSON.stringify([record.agent, record.model]);
    const model = models.get(key) ?? {
      ...totals(),
      agent: record.agent,
      model: record.model,
    };
    add(model, record);
    models.set(key, model);
    add(total, record);
    if (record.sessionKnown !== false) total.sessions.add(JSON.stringify([record.agent, record.session]));
  }
  return { total, agents, models: [...models.values()], buckets, hourly, step };
}
