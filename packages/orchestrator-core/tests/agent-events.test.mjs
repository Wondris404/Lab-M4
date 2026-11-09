import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { diffStats, reviewSummary, runPlanningSession } from '../src/live-plan.mjs';
import { runSimulatedSession, simulatedAgents } from '../testing/simulated-run.mjs';

const codex = { provider: 'codex', executable: 'codex.exe', model: 'test-codex' };
const grok = { provider: 'grok', executable: 'grok.exe', model: 'test-grok' };
const opencode = { provider: 'opencode', executable: 'opencode.exe', model: 'test-opencode' };
const scratch = resolve('.lab-m4/test-tmp/agent-events');

test('the manager prompt lists every vendor and asks it to pick the best worker with a reason', async () => {
  let planningPrompt = '';
  await runPlanningSession({
    manager: codex, workers: [codex, grok, opencode], task: 'Choose wisely',
    approve: () => false,
    async runTurn({ prompt }) {
      planningPrompt = prompt;
      return { text: JSON.stringify({ tasks: [{ id: 'a', worker: 2, task: 'x', dependsOn: [] }] }) };
    },
  });
  assert.match(planningPrompt, /^You are coordinating/);
  assert.match(planningPrompt, /Pick the most suitable worker/);
  assert.match(planningPrompt, /"reason"/);
  const roster = JSON.parse(planningPrompt.split('\n').at(-1)).workers;
  assert.deepEqual(roster, [
    { provider: 'codex', model: 'test-codex' }, { provider: 'grok', model: 'test-grok' },
    { provider: 'opencode', model: 'test-opencode' },
  ]);
});

test('worker selection by the orchestrator routes each task to the chosen vendor and reports why', async () => {
  const events = [];
  const calls = [];
  const longReason = `Fast at docs. ${'x'.repeat(400)}`;
  const result = await runPlanningSession({
    manager: codex, workers: [codex, grok, opencode], task: 'Split the work',
    approve: () => true,
    onEvent: (event) => events.push(event),
    async runTurn({ prompt, provider, model }) {
      if (prompt.startsWith('You are coordinating')) return { text: JSON.stringify({ tasks: [
        { id: 'api', worker: 1, task: 'Design the API', dependsOn: [], reason: 'Grok is quick at API sketches.' },
        { id: 'docs', worker: 2, task: 'Write docs', dependsOn: ['api'], reason: longReason },
        { id: 'tests', worker: 0, task: 'Plan tests', dependsOn: [] },
      ] }), tokens: 12 };
      calls.push({ provider, model, task: JSON.parse(prompt.slice(prompt.indexOf('{'))).task });
      return { text: `${provider} proposal` };
    },
  });
  assert.equal(result.status, 'proposed');
  assert.deepEqual(calls.map(({ provider, task }) => `${task}:${provider}`).sort(),
    ['Design the API:grok', 'Plan tests:codex', 'Write docs:opencode']);
  const plan = events.find(({ type }) => type === 'plan');
  assert.deepEqual(plan.tasks.map(({ id, agent }) => `${id}:${agent.provider}/${agent.model}`),
    ['api:grok/test-grok', 'tests:codex/test-codex', 'docs:opencode/test-opencode']);
  assert.equal(plan.tasks[0].reason, 'Grok is quick at API sketches.');
  assert.ok(plan.tasks.find(({ id }) => id === 'docs').reason.length <= 300);
  assert.equal(plan.tasks.find(({ id }) => id === 'tests').reason, null);
  assert.ok(Object.isFrozen(plan));
});

test('rejects a plan whose reason is not text', async () => {
  await assert.rejects(runPlanningSession({
    manager: codex, workers: [codex, grok], task: 'x', approve: () => true,
    runTurn: async () => ({ text: JSON.stringify({ tasks: [{ id: 'a', worker: 0, task: 'x', dependsOn: [], reason: 5 }] }) }),
  }), /invalid task/);
});

test('events describe concurrent workers from different vendors in a sensible order', async () => {
  mkdirSync(scratch, { recursive: true });
  const { events, result, project } = await runSimulatedSession({ speed: 0.2, root: scratch });
  try {
    assert.equal(result.status, 'needs-review');
    assert.equal(result.project.integration.status, 'verified');
    const types = events.map(({ type }) => type);
    assert.equal(types[0], 'run-start');
    assert.equal(types.at(-1), 'done');
    assert.ok(types.indexOf('plan') < types.indexOf('worker-start'));
    const starts = events.filter(({ type, correction }) => type === 'worker-start' && !correction);
    assert.deepEqual(new Set(starts.map(({ agent }) => agent.provider)), new Set(['codex', 'grok', 'opencode']));
    // All three initial workers start before any of them finishes: they run concurrently.
    const firstDone = types.indexOf('worker-done');
    assert.ok(events.indexOf(starts.at(-1)) < firstDone);
    const failing = events.find(({ type, task, correction }) => type === 'worker-done' && task === 'toggle' && !correction);
    assert.equal(failing.status, 'needs-repair');
    assert.notEqual(failing.diffCheck, 0);
    const review = events.find(({ type, final }) => type === 'review-done' && !final);
    assert.deepEqual(review.repairs, ['toggle']);
    const repaired = events.find(({ type, correction }) => type === 'worker-done' && correction);
    assert.equal(repaired.status, 'proposed');
    assert.equal(repaired.agent.provider, 'grok');
    assert.ok(events.some(({ type, status }) => type === 'integration' && status === 'verified'));
    for (const event of events) {
      assert.equal(typeof event.at, 'number');
      assert.ok(Object.isFrozen(event));
      assert.ok(!JSON.stringify(event).includes(project), 'events must not leak local paths');
    }
    assert.equal(simulatedAgents.workers.length, 3);
  } finally {
    rmSync(join(project), { recursive: true, force: true });
  }
});

test('a throwing event listener never breaks the run', async () => {
  const result = await runPlanningSession({
    manager: codex, workers: [codex, grok], task: 'x', approve: () => true,
    onEvent() { throw new Error('listener bug'); },
    runTurn: async ({ prompt }) => prompt.startsWith('You are coordinating')
      ? { text: JSON.stringify({ tasks: [{ id: 'a', worker: 1, task: 'x', dependsOn: [] }] }) }
      : { text: 'ok' },
  });
  assert.equal(result.status, 'proposed');
});

test('a failing worker and a denied plan both end with a done event', async () => {
  const events = [];
  await runPlanningSession({
    manager: codex, workers: [codex, grok], task: 'x', approve: () => true, onEvent: (event) => events.push(event),
    runTurn: async ({ prompt }) => {
      if (prompt.startsWith('You are coordinating')) return { text: JSON.stringify({ tasks: [{ id: 'a', worker: 1, task: 'x', dependsOn: [] }] }) };
      throw new Error('CLI crashed');
    },
  });
  const failed = events.find(({ type }) => type === 'worker-done');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'CLI crashed');
  assert.deepEqual(events.at(-1).type, 'done');
  assert.equal(events.at(-1).status, 'incomplete');
  const denied = [];
  await runPlanningSession({
    manager: codex, workers: [codex, grok], task: 'x', approve: () => false, onEvent: (event) => denied.push(event),
    runTurn: async () => ({ text: JSON.stringify({ tasks: [{ id: 'a', worker: 0, task: 'x', dependsOn: [] }] }) }),
  });
  assert.equal(denied.at(-1).status, 'not-approved');
});

test('diff statistics ignore headers and review summaries prefer the JSON summary', () => {
  assert.deepEqual(diffStats('--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n context'), { added: 2, removed: 1 });
  assert.deepEqual(diffStats(undefined), { added: 0, removed: 0 });
  assert.equal(reviewSummary('```json\n{"summary":"All good","repairTaskIds":[]}\n```'), 'All good');
  assert.equal(reviewSummary('Plain   text\nreview'), 'Plain text review');
  assert.ok(reviewSummary('y'.repeat(2000)).length <= 600);
});
