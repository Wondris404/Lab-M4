export const providers = [
  'codex',
  'grok-build',
  'opencode',
  'antigravity',
] as const;
export type Provider = (typeof providers)[number];

export interface UsageRecord {
  provider: Provider;
  sessionId: string;
  /** False when a record cannot be linked to a confirmed provider session. */
  sessionKnown?: boolean;
  model: string;
  /** ISO 8601 timestamp with timezone. */
  timestamp: string;
  /** Includes cached input; nonnegative integer. */
  inputTokens: number;
  /** Subset of inputTokens. */
  cachedInputTokens: number;
  /** Includes reasoning tokens; nonnegative integer. */
  outputTokens: number;
  /** Subset of outputTokens. */
  reasoningTokens: number;
  speed: 'standard' | 'fast' | 'unknown';
  costUsd?: number;
  costSource: 'skutočné' | 'odhad' | 'neznáme';
  /** Machine-readable uncertainty markers, without source contents. */
  warnings?: string[];
}
