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
export interface ParseResult {
  records: UsageRecord[];
  warnings: number;
  limits: LimitSnapshot[];
  mismatchFields: Record<string, number>;
  warningDetails?: string[];
  partial?: boolean;
}
export const emptyResult = (): ParseResult => ({
  records: [],
  warnings: 0,
  limits: [],
  mismatchFields: {},
});
export interface Parser {
  readonly provider: Provider;
  parse(path: string): Promise<ParseResult>;
}
