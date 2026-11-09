import type { Provider, UsageRecord } from '../core/types.js';
export interface LimitWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}
export interface LimitSnapshot {
  timestamp: string;
  sessionId: string;
  primary?: LimitWindow;
  secondary?: LimitWindow;
}
export type CountRisk = 'double-count' | 'under-count' | 'both' | 'none';

export function mergeCountRisk(left: CountRisk, right: CountRisk): CountRisk {
  if (left === 'none') return right;
  if (right === 'none' || left === right) return left;
  return 'both';
}

export interface ParseResult {
  records: UsageRecord[];
  warnings: number;
  limits: LimitSnapshot[];
  mismatchFields: Record<string, number>;
  warningDetails?: string[];
  partial?: boolean;
  /** Why an uncertain total must not be treated as an invoice. */
  countRisk?: CountRisk;
}
export const emptyResult = (): ParseResult => ({
  records: [],
  warnings: 0,
  limits: [],
  mismatchFields: {},
});
export interface Parser {
  readonly provider: Provider;
  parse(path: string, historyOnly?: boolean): Promise<ParseResult>;
}
