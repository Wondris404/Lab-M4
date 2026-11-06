import { expect, it } from 'vitest';
import { emptyResult } from '../src/parsers/contracts.js';
import { scanSnapshotId } from '../src/service/protocol.js';

it('binds pagination to changes in whether a session is known', () => {
  const base = emptyResult();
  base.records.push({
    provider: 'grok-build', sessionId: 'synthetic', model: 'unknown',
    timestamp: '2025-01-01T00:00:00Z', inputTokens: 1, cachedInputTokens: 0,
    outputTokens: 1, reasoningTokens: 0, speed: 'unknown', costSource: 'neznáme',
  });
  const unknown = { ...base, records: [Object.assign({}, base.records[0]!, { sessionKnown: false })] };
  const known = { ...base, records: [Object.assign({}, base.records[0]!, { sessionKnown: true })] };
  expect(scanSnapshotId(unknown)).not.toBe(scanSnapshotId(known));
  expect(scanSnapshotId(unknown)).not.toBe(scanSnapshotId(base));
});
