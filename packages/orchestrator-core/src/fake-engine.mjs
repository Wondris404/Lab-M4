import { createHash, randomUUID } from 'node:crypto';
import { reviewWorkerResult } from './review.mjs';
import { stopShippedTransport } from './transport-stop.mjs';
import { captureSyntheticAttempt } from './worktree.mjs';

// The lifecycle stays fake: it does not start Codex or Grok. A worker attempt
// reads a git diff and a test exit from an isolated worktree. OS STOP runs
// only when a shipped transport process is attached.
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const MAX_EVENTS = 64;
const MAX_ATTEMPTS = 2;

function event(state, type) {
  // Reserve one terminal event beyond the ordinary limit. This lets timeout,
  // STOP and log exhaustion remain durable when no regular slots remain.
  if (state.events.length >= MAX_EVENTS && !['fake_stop', 'supervisor_stop', 'timeout', 'event_limit'].includes(type))
    throw new Error('Synthetic event limit reached');
  state.events.push({ sequence: state.events.length + 1, type });
}

function active(state, now) {
  if (state.mode !== 'fake' || state.version !== 1) throw new Error('Unsupported session');
  if (TERMINAL.has(state.status)) throw new Error('Session is terminal');
  if (!Number.isFinite(now)) throw new Error('Invalid clock');
  if (now >= state.deadline) {
    state.status = 'failed';
    state.task.status = 'failed';
    state.approval = null;
    event(state, 'timeout');
    return false;
  }
  if (state.events.length >= MAX_EVENTS) {
    state.status = 'failed';
    state.task.status = 'failed';
    state.approval = null;
    event(state, 'event_limit');
    return false;
  }
  return true;
}

export function createFakeSession({ now = Date.now(), tokenLimit = 100_000, costLimitEur = 5 } = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(tokenLimit) || tokenLimit < 0 ||
      !Number.isFinite(costLimitEur) || costLimitEur < 0) throw new Error('Invalid limits');
  const state = {
    version: 1, mode: 'fake', id: randomUUID(), status: 'queued', deadline: now + 15 * 60_000,
    budget: { tokenLimit, costLimitEur, syntheticTokens: 0, syntheticCostEur: 0 },
    task: { id: 'synthetic-task', status: 'queued', attempts: 0, review: null },
    approval: null, events: [],
  };
  event(state, 'fake_manager_delegated');
  return state;
}

export function stepFake(state, now = Date.now()) {
  if (!active(state, now)) return state;
  if (state.status === 'waiting-approval') throw new Error('Approval is pending');
  if (state.status === 'queued') {
    // These figures are synthetic, have no billing meaning, and reserve a full turn.
    if (state.budget.syntheticTokens + 500 > state.budget.tokenLimit ||
        state.budget.syntheticCostEur + 0.01 > state.budget.costLimitEur) {
      state.status = 'failed'; state.task.status = 'failed'; event(state, 'budget_exhausted');
      return state;
    }
    if (state.task.attempts >= MAX_ATTEMPTS) {
      state.status = 'failed'; state.task.status = 'failed'; event(state, 'attempt_limit');
      return state;
    }
    const action = {
      task: state.task.id, attempt: state.task.attempts + 1,
      command: 'fake-edit', args: ['synthetic-document'], workspace: '<synthetic>',
      scope: 'fake-only', nonce: randomUUID(),
    };
    const id = createHash('sha256').update(JSON.stringify(action)).digest('hex');
    state.approval = { id, action };
    state.status = 'waiting-approval'; state.task.status = 'waiting-approval';
    event(state, 'synthetic_approval_requested');
    return state;
  }
  if (state.status === 'running') {
    state.task.attempts++;
    state.budget.syntheticTokens += 500; state.budget.syntheticCostEur += 0.01;
    const artifact = captureSyntheticAttempt(state.task.attempts);
    const verdict = reviewWorkerResult(artifact);
    state.task.review = { ...artifact, decision: verdict.decision, reason: verdict.reason };
    state.status = 'review'; state.task.status = 'review';
    event(state, 'fake_worker_result');
    return state;
  }
  if (state.status === 'review') {
    const verdict = reviewWorkerResult({
      diff: state.task.review?.diff, test: state.task.review?.test,
    });
    state.task.review = { ...state.task.review, decision: verdict.decision, reason: verdict.reason };
    if (verdict.decision === 'accept') {
      state.status = 'completed'; state.task.status = 'completed'; event(state, 'fake_manager_accepted');
    } else if (state.task.attempts >= MAX_ATTEMPTS) {
      state.status = 'failed'; state.task.status = 'failed'; event(state, 'attempt_limit');
    } else {
      state.status = 'queued'; state.task.status = 'queued'; event(state, 'fake_manager_requested_correction');
    }
    return state;
  }
  throw new Error('Unsupported session state');
}

export function decideFakeApproval(state, id, decision, now = Date.now()) {
  if (!active(state, now)) return state;
  if (state.status !== 'waiting-approval' || !state.approval || state.approval.id !== id)
    throw new Error('Approval is absent or does not match');
  const current = createHash('sha256').update(JSON.stringify(state.approval.action)).digest('hex');
  if (current !== id) throw new Error('Approval action has changed');
  if (decision !== 'approve' && decision !== 'deny') throw new Error('Invalid decision');
  state.approval = null;
  if (decision === 'deny') {
    state.status = 'failed'; state.task.status = 'failed'; event(state, 'synthetic_approval_denied');
  } else {
    state.status = 'running'; state.task.status = 'running'; event(state, 'synthetic_approval_granted');
  }
  return state;
}

export async function stopFake(state, ownedTransport) {
  if (state.mode !== 'fake' || state.version !== 1) throw new Error('Unsupported session');
  if (ownedTransport) state.jobStop = await stopShippedTransport(ownedTransport);
  if (TERMINAL.has(state.status)) return state;
  state.approval = null; state.status = 'cancelled'; state.task.status = 'cancelled';
  event(state, ownedTransport ? 'supervisor_stop' : 'fake_stop');
  return state;
}

export function resumeFake(state, now = Date.now()) {
  if (!active(state, now)) return state;
  // Never replay an approved action after restart. Pending approvals are invalidated.
  if (state.status === 'running') {
    state.status = 'failed'; state.task.status = 'failed'; event(state, 'interrupted');
  } else if (state.status === 'waiting-approval') {
    state.approval = null; state.status = 'queued'; state.task.status = 'queued';
    event(state, 'synthetic_approval_invalidated');
  }
  return state;
}
