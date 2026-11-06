import type { UsageItem } from './UsageTab';

export type SortField =
  | 'timestamp'
  | 'agent'
  | 'model'
  | 'session'
  | 'input'
  | 'output'
  | 'cached'
  | 'reasoning';
export interface Filters {
  agent: string;
  model: string;
  day: string;
  session: string;
}

/** Avoid reporting a rounded integer when the precise token total is unknown. */
export function addUsageTokens(total: number | undefined, record: Pick<UsageItem, 'input' | 'output'>): number | undefined {
  if (total === undefined || !Number.isSafeInteger(record.input) || record.input < 0 ||
      !Number.isSafeInteger(record.output) || record.output < 0) return undefined;
  const inputTotal = total + record.input;
  if (!Number.isSafeInteger(inputTotal)) return undefined;
  const combined = inputTotal + record.output;
  return Number.isSafeInteger(combined) ? combined : undefined;
}

export function usageState(
  loading: boolean,
  error: string | undefined,
  sourceCount: number,
  recordCount: number,
) {
  if (loading) return 'loading';
  if (error) return 'error';
  if (!sourceCount) return 'needs-source';
  if (!recordCount) return 'empty';
  return 'ready';
}

export function selectUsage(
  records: UsageItem[],
  filters: Filters,
  sort: SortField,
  descending: boolean,
): UsageItem[] {
  return records
    .filter(
      (record) =>
        (!filters.agent || record.agent === filters.agent) &&
        (!filters.model || record.model === filters.model) &&
        (!filters.day || record.timestamp.startsWith(filters.day)) &&
        (!filters.session || (record.sessionKnown !== false && record.session === filters.session)),
    )
    .sort((a, b) => {
      const left = a[sort],
        right = b[sort];
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      return descending ? -order : order;
    });
}
