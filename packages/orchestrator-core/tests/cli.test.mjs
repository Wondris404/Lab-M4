import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}
function ok(...args) {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fake CLI persists the review/correction lifecycle across invocations', () => {
  assert.notEqual(run('start').status, 0);
  let state = ok('start', '--fake');
  const id = state.id;
  state = ok('step', id);
  const first = state.approval.id;
  assert.notEqual(run('approve', id, 'wrong').status, 0);
  state = ok('approve', id, first);
  assert.equal(state.status, 'running');
  state = ok('step', id);
  assert.equal(state.status, 'review');
  state = ok('step', id);
  assert.equal(state.status, 'queued');
  state = ok('step', id);
  assert.notEqual(state.approval.id, first);
  assert.notEqual(run('approve', id, first).status, 0);
  ok('approve', id, state.approval.id);
  ok('step', id);
  state = ok('step', id);
  assert.equal(state.status, 'completed');
  assert.equal(ok('status', id).task.attempts, 2);
  assert.equal(ok('budget', id).syntheticTokens, 1000);
  assert.equal(ok('events', id).at(-1).type, 'fake_manager_accepted');
});

test('fake CLI persists STOP during approval and rejects resume', () => {
  const state = ok('start', '--fake');
  const pending = ok('step', state.id);
  assert.equal(ok('stop', state.id).status, 'cancelled');
  assert.notEqual(run('approve', state.id, pending.approval.id).status, 0);
  assert.notEqual(run('resume', state.id).status, 0);
});
