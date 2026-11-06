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

test('rejects inconsistent component totals without changing the ledger', () => {
  const ledger = createUsageLedger();
  for (const counts of [
    { inputTokens: 999999, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    { inputTokens: 5, outputTokens: 2, cachedInputTokens: 6, reasoningOutputTokens: 0, totalTokens: 7 },
    { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 3, totalTokens: 7 },
    { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 6 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER },
  ]) {
    const invalid = event('synthetic', 0);
    invalid.params.tokenUsage.total = counts;
    assert.throws(() => recordCodexUsage(ledger, invalid), /Invalid token totals/);
    assert.equal(usageBudgetStatus(ledger).reportedTokens, 0);
    assert.equal(usageBudgetStatus(ledger).canSchedule, false);
  }
  const restored = createUsageLedger();
  restored.threads.synthetic = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  assert.throws(() => usageBudgetStatus(restored), /Invalid aggregate/);
});

test('rejects cumulative subset increases larger than their parent increases', () => {
  const ledger = createUsageLedger();
  const first = event('thread', 0);
  first.params.tokenUsage.total = {
    inputTokens: 100, cachedInputTokens: 0,
    outputTokens: 100, reasoningOutputTokens: 0, totalTokens: 200,
  };
  recordCodexUsage(ledger, first);
  const before = structuredClone(ledger);
  for (const change of [
    { inputTokens: 101, cachedInputTokens: 2, outputTokens: 100, reasoningOutputTokens: 0, totalTokens: 201 },
    { inputTokens: 100, cachedInputTokens: 0, outputTokens: 101, reasoningOutputTokens: 2, totalTokens: 201 },
  ]) {
    const next = event('thread', 0);
    next.params.tokenUsage.total = change;
    assert.throws(() => recordCodexUsage(ledger, next), /reconcile/i);
    assert.deepEqual(ledger, before);
  }
  const valid = event('thread', 0);
  valid.params.tokenUsage.total = {
    inputTokens: 102, cachedInputTokens: 2,
    outputTokens: 101, reasoningOutputTokens: 1, totalTokens: 203,
  };
  assert.equal(recordCodexUsage(ledger, valid).reportedTokens, 203);
});

test('rejects an invalid existing thread before modifying the ledger', () => {
  const ledger = createUsageLedger();
  ledger.threads.corrupt = {
    inputTokens: 5, cachedInputTokens: 6,
    outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 5,
  };
  const before = structuredClone(ledger);
  assert.throws(() => recordCodexUsage(ledger, event('new', 1)), /Invalid aggregate/);
  assert.deepEqual(ledger, before);
});
