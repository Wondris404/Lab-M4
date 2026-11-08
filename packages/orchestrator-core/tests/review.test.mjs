import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeSession, stepFake, stopFake } from '../src/fake-engine.mjs';
import { reviewWorkerResult } from '../src/review.mjs';
import { captureSyntheticAttempt, createIsolatedWorktrees, removeWorkspace } from '../src/worktree.mjs';

test('review reads the diff and the test exit', () => {
  const passing = captureSyntheticAttempt(2);
  assert.equal(reviewWorkerResult(passing).decision, 'accept');
  assert.match(passing.diff, /^diff --git /m);
  assert.match(passing.diff, /^\+corrected$/m);
  assert.equal(reviewWorkerResult({ diff: passing.diff, test: { status: 1 } }).reason, 'tests-failed');
  assert.equal(reviewWorkerResult({ diff: '', test: { status: 0 } }).reason, 'empty-diff');
  assert.equal(reviewWorkerResult({ diff: 'diff --git a/task.txt b/task.txt\n+draft\n', test: { status: 0 } }).reason, 'diff-rejected');
  assert.throws(() => reviewWorkerResult({ diff: passing.diff, test: {} }), /diff and a test/);

  const rejected = createFakeSession({ now: 1 });
  rejected.status = 'review';
  rejected.task.status = 'review';
  rejected.task.attempts = 2;
  rejected.task.review = { diff: passing.diff, test: { status: 1 } };
  stepFake(rejected, 1);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.events.at(-1).type, 'attempt_limit');

  const accepted = createFakeSession({ now: 1 });
  accepted.status = 'review';
  accepted.task.status = 'review';
  accepted.task.attempts = 1;
  accepted.task.review = passing;
  stepFake(accepted, 1);
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.events.at(-1).type, 'fake_manager_accepted');
});

test('worktrees do not share writes and a path cannot be added twice', () => {
  const workspace = createIsolatedWorktrees(2);
  try {
    assert.notEqual(workspace.trees[0], workspace.trees[1]);
    writeFileSync(join(workspace.trees[0], 'only-a.txt'), 'a');
    assert.equal(existsSync(join(workspace.trees[1], 'only-a.txt')), false);
    const again = spawnSync('git', ['worktree', 'add', '--detach', workspace.trees[0], 'HEAD'], {
      cwd: workspace.repo, encoding: 'utf8',
    });
    assert.notEqual(again.status, 0);
  } finally {
    removeWorkspace(workspace.parent);
  }
});

test('STOP refuses a Node peer that prints the supervisor line', async () => {
  const child = spawn(process.execPath, ['-e', `
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stderr.write('LAB_M4_RESULT stop\\nLAB_M4_JOB_STOP 1 0\\n');
      process.exit(5);
    });
  `], { windowsHide: true });
  try {
    await assert.rejects(stopFake(createFakeSession({ now: 1 }), child), /Node peer/);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
