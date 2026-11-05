import type { Provider, UsageRecord } from '../core/types.js';

/** Future aggregation contracts only; no dashboard aggregation implemented. */
export interface Aggregations {
  byProvider(
    records: readonly UsageRecord[],
  ): Partial<Record<Provider, number>>;
  byModel(records: readonly UsageRecord[]): Record<string, number>;
  byDay(
    records: readonly UsageRecord[],
    timeZone: string,
  ): Record<string, number>;
}

/** Cached input and reasoning are subsets, so they must not be added again. */
export function totalTokens(records: readonly UsageRecord[]): number {
  return records.reduce(
    (sum, record) => sum + record.inputTokens + record.outputTokens,
    0,
  );
}
