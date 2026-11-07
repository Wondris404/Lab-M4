import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSession, decideFakeApproval, resumeFake, stepFake, stopFake } from '../src/fake-engine.mjs';

const now = 1_000;
const approve = (state) => decideFakeApproval(state, state.approval.id, 'approve', now);

test('fake manager delegates, reviews, requests one correction, then accepts', () => {
  const state = createFakeSession({ now });
  stepFake(state, now);
  const firstId = state.approval.id;
  assert.equal(state.status, 'waiting-approval');
  approve(state); stepFake(state, now);
  assert.equal(state.status, 'review');
  assert.equal(state.task.review.decision, 'repair');
  assert.equal(state.task.review.reason, 'tests-failed');
  assert.match(state.task.review.diff, /^diff --git /m);
  assert.match(state.task.review.diff, /^\+draft$/m);
  assert.equal(state.task.review.test.status, 1);
  stepFake(state, now);
  assert.equal(state.status, 'queued');
  stepFake(state, now);
  assert.notEqual(state.approval.id, firstId);
  assert.throws(() => decideFakeApproval(state, firstId, 'approve', now), /does not match/);
  approve(state); stepFake(state, now); stepFake(state, now);
  assert.equal(state.status, 'completed');
  assert.equal(state.task.attempts, 2);
  assert.equal(state.task.review.decision, 'accept');
  assert.equal(state.task.review.reason, 'diff-and-tests');
  assert.match(state.task.review.diff, /^\+corrected$/m);
  assert.equal(state.task.review.test.status, 0);
  assert.equal(state.budget.syntheticTokens, 1000);
  assert.throws(() => stepFake(state, now), /terminal/);
  assert.deepEqual(state.events.map((e) => e.sequence), state.events.map((_, i) => i + 1));
});

test('deny and STOP invalidate approval and cannot start a fake worker', async () => {
  const denied = createFakeSession({ now });
  stepFake(denied, now);
  decideFakeApproval(denied, denied.approval.id, 'deny', now);
  assert.equal(denied.status, 'failed');
  assert.equal(denied.task.attempts, 0);

  const stopped = createFakeSession({ now });
  stepFake(stopped, now);
  const id = stopped.approval.id;
  await stopFake(stopped);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.approval, null);
  assert.throws(() => decideFakeApproval(stopped, id, 'approve', now), /terminal/);
  assert.throws(() => resumeFake(stopped, now), /terminal/);
});

test('synthetic budget and timeout stop scheduling', () => {
  const exhausted = createFakeSession({ now, tokenLimit: 499 });
  stepFake(exhausted, now);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.events.at(-1).type, 'budget_exhausted');
  const cost = createFakeSession({ now, costLimitEur: 0.009 });
  stepFake(cost, now);
  assert.equal(cost.status, 'failed');
  const timedOut = createFakeSession({ now });
  stepFake(timedOut, timedOut.deadline);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.events.at(-1).type, 'timeout');
});

test('restart invalidates pending approval and does not replay a running action', () => {
  const pending = createFakeSession({ now });
  stepFake(pending, now);
  const old = pending.approval.id;
  resumeFake(pending, now);
  assert.equal(pending.status, 'queued');
  stepFake(pending, now);
  assert.notEqual(pending.approval.id, old);
  assert.throws(() => decideFakeApproval(pending, old, 'approve', now), /does not match/);
  approve(pending);
  resumeFake(pending, now);
  assert.equal(pending.status, 'failed');
  assert.equal(pending.task.attempts, 0);
});

test('approval cannot authorize changed action, and STOP survives a full event log', async () => {
  const state = createFakeSession({ now });
  stepFake(state, now);
  const id = state.approval.id;
  state.approval.action.workspace = '<different-synthetic-workspace>';
  assert.throws(() => decideFakeApproval(state, id, 'approve', now), /action has changed/);
  while (state.events.length < 64) state.events.push({ sequence: state.events.length + 1, type: 'fixture' });
  await stopFake(state);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.approval, null);
  assert.equal(state.events.at(-1).type, 'fake_stop');
});

test('timeout is recorded even when the synthetic event log is full', () => {
  const state = createFakeSession({ now });
  // This sequence fills the log using only supported transitions.
  for (let i = 0; i < 31; i++) {
    stepFake(state, now);
    resumeFake(state, now);
  }
  stepFake(state, now);
  assert.equal(state.events.length, 64);
  assert.equal(state.status, 'waiting-approval');
  stepFake(state, state.deadline);
  assert.equal(state.status, 'failed');
  assert.equal(state.task.status, 'failed');
  assert.equal(state.approval, null);
  assert.equal(state.events.at(-1).type, 'timeout');
  assert.equal(state.events.length, 65);
});

test('a full synthetic event log fails closed before another transition', () => {
  const state = createFakeSession({ now });
  for (let i = 0; i < 31; i++) {
    stepFake(state, now);
    resumeFake(state, now);
  }
  stepFake(state, now);
  const approval = state.approval.id;
  decideFakeApproval(state, approval, 'approve', now);
  assert.equal(state.status, 'failed');
  assert.equal(state.task.status, 'failed');
  assert.equal(state.approval, null);
  assert.equal(state.events.at(-1).type, 'event_limit');
  assert.equal(state.events.length, 65);
  assert.throws(() => decideFakeApproval(state, approval, 'approve', now), /terminal/);
});
