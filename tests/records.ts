import type { UsageRecord } from '../src/core/types.js';

export const record: UsageRecord = {
  provider: 'codex',
  sessionId: 'test-session',
  model: 'test-model',
  timestamp: '2026-01-01T12:00:00Z',
  inputTokens: 1000,
  cachedInputTokens: 400,
  outputTokens: 200,
  reasoningTokens: 50,
  speed: 'standard',
  costSource: 'odhad',
};
