import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageLedger, recordCodexUsage, usageBudgetStatus } from '../src/usage-ledger.mjs';

const event = (threadId, totalTokens) => ({ method: 'thread/tokenUsage/updated', params: {
  threadId, turnId: 'synthetic', tokenUsage: { total: {
    inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, totalTokens,
  } },
} });

test('counts cumulative Codex totals once per thread and pauses on unknown cost', () => {
  const ledger = createUsageLedger();
  recordCodexUsage(ledger, event('one', 10));
  recordCodexUsage(ledger, event('one', 10));
  recordCodexUsage(ledger, event('one', 15));
  const status = recordCodexUsage(ledger, event('two', 5));
  assert.equal(status.reportedTokens, 20);
  assert.equal(status.subscriptionBilling, 'unknown');
  assert.equal(status.cost.kind, 'unknown');
  assert.equal(status.canSchedule, false);
  assert.equal(usageBudgetStatus(JSON.parse(JSON.stringify(ledger))).reportedTokens, 20);
});

test('rejects invalid or decreasing cumulative totals and handles hostile IDs', () => {
  const ledger = createUsageLedger();
  recordCodexUsage(ledger, event('__proto__', 10));
  assert.equal(usageBudgetStatus(ledger).reportedTokens, 10);
  assert.throws(() => recordCodexUsage(ledger, event('__proto__', 9)), /decreased/);
  assert.throws(() => recordCodexUsage(ledger, event('bad', -1)), /Invalid token/);
  assert.throws(() => recordCodexUsage(ledger, { method: 'other' }), /Invalid usage/);
});
