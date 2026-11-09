import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runPlanningSession } from '../src/live-plan.mjs';
import { readProject } from '../src/project-worktrees.mjs';

const codex = { provider: 'codex', executable: 'codex.exe', model: 'test-codex' };
const grok = { provider: 'grok', executable: 'grok.exe', model: 'test-grok' };
const assignment = { manager: codex, workers: [codex, grok], task: 'Synthetic planning request' };
const tasks = [
  { id: 'review', worker: 1, task: 'Review the first proposal', dependsOn: ['design'] },
  { id: 'design', worker: 0, task: 'Propose a design', dependsOn: [] },
  { id: 'checks', worker: 1, task: 'Propose checks', dependsOn: [] },
];
const managerResponse = { text: JSON.stringify({ tasks }), tokens: null };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('runs independent workers in parallel after approval and waits for their dependencies', async () => {
  const active = [];
  const bothStarted = deferred();
  const release = deferred();
  let approved = false;
  const resultPromise = runPlanningSession({
    ...assignment,
    approve(plan) {
      assert.deepEqual(plan.map(({ id }) => id), ['design', 'checks', 'review']);
      assert.ok(plan.every(Object.isFrozen));
      approved = true;
      return true;
    },
    async runTurn({ prompt, model, onStopped }) {
      if (prompt.startsWith('You are coordinating')) return managerResponse;
      assert.equal(approved, true);
      if (prompt.includes('Review the first proposal')) {
        assert.match(prompt, /design-proposal/);
        assert.equal(model, 'test-grok');
        return { text: 'review-proposal' };
      }
      active.push(model);
      if (active.length === 2) bothStarted.resolve();
      await release.promise;
      onStopped({ before: 2, after: 0 });
      return { text: model === 'test-codex' ? 'design-proposal' : 'check-proposal' };
    },
  });
  try {
    await Promise.race([bothStarted.promise, resultPromise]);
    assert.deepEqual(active, ['test-codex', 'test-grok']);
  } finally {
    release.resolve();
  }
  const result = await resultPromise;
  assert.equal(result.status, 'proposed');
  assert.equal(result.workers[0].result.cleanup.after, 0);
});

test('never starts workers after denial or for invalid dependency graphs', async () => {
  const runTurn = async ({ prompt }) => {
    assert.match(prompt, /^You are coordinating/);
    return managerResponse;
  };
  const denied = await runPlanningSession({ ...assignment, runTurn, approve: () => false });
  assert.equal(denied.status, 'not-approved');
  assert.deepEqual(denied.workers, []);
  await assert.rejects(runPlanningSession({
    ...assignment,
    runTurn: async () => ({ text: JSON.stringify({ tasks: [
      { id: 'loop', worker: 0, task: 'cycle', dependsOn: ['loop'] },
    ] }) }),
    approve() { assert.fail('invalid plan cannot reach approval'); },
  }), /cycle/);
});

test('aborting propagates to both in-flight workers and prevents dependent dispatch', async () => {
  const controller = new AbortController();
  let launched = 0;
  const result = await runPlanningSession({
    ...assignment,
    signal: controller.signal,
    approve: () => true,
    async runTurn({ prompt, signal, onStopped }) {
      if (prompt.startsWith('You are coordinating')) return managerResponse;
      launched += 1;
      assert.doesNotMatch(prompt, /Review the first proposal/);
      const stopped = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      if (launched === 2) controller.abort();
      await stopped;
      onStopped({ before: 2, after: 0 });
      throw new Error('Worker interrupted');
    },
  });
  assert.equal(launched, 2);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.workers.slice(0, 2).map(({ cleanup }) => cleanup.after), [0, 0]);
  assert.equal(result.workers[2].status, 'cancelled');
});

test('STOP cancels a pending approval even if the approval handler later accepts', async () => {
  const controller = new AbortController();
  const asked = deferred();
  const answer = deferred();
  let calls = 0;
  const pending = runPlanningSession({
    ...assignment,
    signal: controller.signal,
    approve() { asked.resolve(); return answer.promise; },
    async runTurn() { calls += 1; return managerResponse; },
  });
  await asked.promise;
  controller.abort();
  const result = await pending;
  answer.resolve(true);
  assert.equal(result.status, 'cancelled');
  assert.equal(calls, 1);
});

test('works in an ordinary folder with named files from disk and leaves the source intact', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lab-m4-folder-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'plain folder');
  const docs = join(folder, 'docs');
  mkdirSync(docs, { recursive: true });
  const path = 'docs/Prvý súbor.txt';
  writeFileSync(join(folder, path), 'from disk\r\n');
  writeFileSync(join(folder, 'unselected.txt'), 'private text\n');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'outside.txt'), 'outside text');
  symlinkSync(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readProject(folder, ['README.md']), /README\.md.*sa vo vybranom priečinku nenašiel/);
  await assert.rejects(readProject(folder, ['linked/outside.txt']), /regular file inside/);
  const result = await runPlanningSession({
    ...assignment, project: folder, files: ['docs\\Prvý súbor.txt'],
    approve(_plan, scope) { assert.deepEqual(scope, { base: null, files: [path] }); return true; },
    async runTurn({ prompt }) {
      assert.doesNotMatch(prompt, /private text|outside text/);
      if (prompt.startsWith('You are coordinating'))
        return { text: JSON.stringify({ tasks: [{ id: 'edit', worker: 0, task: 'Edit', dependsOn: [], files: [path] }] }) };
      if (prompt.startsWith('Review these real Git diffs')) return { text: '{"summary":"Reviewed","repairTaskIds":[]}' };
      const input = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
      assert.deepEqual(input.files, [{ path, content: 'from disk\r\n' }]);
      return { text: JSON.stringify({ files: [{ path, content: 'proposed edit\r\n' }] }) };
    },
  });
  t.after(() => rmSync(result.project.workspace, { recursive: true, force: true }));
  assert.equal(result.workers[0].status, 'proposed');
  const evidence = result.workers[0].result.evidence;
  assert.deepEqual(evidence.changed, [path]);
  assert.equal(readFileSync(join(evidence.worktree, path), 'utf8'), 'proposed edit\r\n');
  assert.equal(existsSync(join(evidence.worktree, 'unselected.txt')), false);
  assert.equal(readFileSync(join(folder, path), 'utf8'), 'from disk\r\n');
  assert.equal(existsSync(join(folder, '.git')), false);
});

test('passes prerequisite edits to a dependent worker within its approved file scope', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'lab-m4-dependency-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'user.name=Lab-M4', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--template=');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  writeFileSync(join(repo, 'other.txt'), 'other baseline\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'test dependency snapshot');
  const plan = [
    { id: 'dependent', worker: 1, task: 'Extend first change', dependsOn: ['first'], files: ['shared.txt'] },
    { id: 'first', worker: 0, task: 'Change both files', dependsOn: [], files: ['shared.txt', 'other.txt'] },
  ];
  const replacement = (files) => ({ text: JSON.stringify({ files }) });
  const result = await runPlanningSession({
    ...assignment, project: repo, files: ['shared.txt', 'other.txt'], approve: () => true,
    async runTurn({ prompt, model }) {
      if (prompt.startsWith('You are coordinating')) return { text: JSON.stringify({ tasks: plan }) };
      if (prompt.startsWith('Review these real Git diffs')) return { text: '{"summary":"Reviewed","repairTaskIds":[]}' };
      if (model === 'test-codex') return replacement([
        { path: 'shared.txt', content: 'base\nfirst\n' }, { path: 'other.txt', content: 'private proposal\n' },
      ]);
      const input = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
      assert.deepEqual(input.files, [{ path: 'shared.txt', content: 'base\n' }]);
      assert.deepEqual(input.dependencies, [{ id: 'first', sharedChanges: [{ path: 'shared.txt', content: 'base\nfirst\n' }] }]);
      assert.doesNotMatch(prompt, /other.txt|private proposal/);
      return replacement([{ path: 'shared.txt', content: 'base\nfirst\ndependent\n' }]);
    },
  });
  t.after(() => rmSync(result.project.workspace, { recursive: true, force: true }));
  assert.equal(result.workers[1].status, 'proposed');
  assert.match(result.workers[1].result.evidence.diff, /\+first\n\+dependent/);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'base\n');
});

test('isolates real file proposals, reports overlapping edits and sends actual diffs to the manager', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'lab-m4-project-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'user.name=Lab-M4', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--template=');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  writeFileSync(join(repo, 'private.txt'), 'outside-approved-scope\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'test snapshot');
  writeFileSync(join(repo, 'shared.txt'), 'uncommitted-local-edit\n');
  const projectTasks = tasks.filter(({ id }) => id !== 'review').map((task) => ({ ...task, files: ['shared.txt'] }));
  const config = { ...assignment, project: repo, files: ['shared.txt'] };
  let planned = false;
  let reviewed = false;
  let correctionCount = 0;
  let testApprovals = 0;
  const outcome = await runPlanningSession({
    ...config,
    check: { executable: join(repo, 'test.exe'), args: ['check.mjs'] },
    approve(plan, { base, files }) {
      assert.equal(base, git('rev-parse', 'HEAD').trim());
      assert.deepEqual(files, ['shared.txt']);
      assert.deepEqual(plan[0].files, ['shared.txt']);
      planned = true;
      return true;
    },
    approveTests(command, changes) {
      assert.deepEqual(command.args, ['check.mjs']);
      const correction = ++testApprovals === 2;
      assert.deepEqual(changes.map(({ id }) => id), [correction ? 'checks' : 'design']);
      assert.match(changes[0].diff, correction ? /\+test-grok-fixed/ : /\+test-codex/);
      return true;
    },
    approveRepairs(changes) {
      assert.deepEqual(changes.map(({ id }) => id), ['checks']);
      return true;
    },
    async runCheck({ worktree }) {
      assert.match(readFileSync(join(worktree, 'shared.txt'), 'utf8'), /^test-(?:codex|grok-fixed)\n$/);
      writeFileSync(join(worktree, 'shared.txt'), 'test-generated-content\n');
      return { status: 7 };
    },
    async runTurn({ prompt, model }) {
      assert.doesNotMatch(prompt, /outside-approved-scope|uncommitted-local-edit/);
      if (prompt.startsWith('You are coordinating')) return { text: JSON.stringify({ tasks: projectTasks }) };
      assert.ok(planned);
      if (prompt.startsWith('Review these real Git diffs')) {
        if (prompt.includes('final review after the single correction round')) {
          assert.match(prompt, /\+test-grok-fixed/);
          assert.match(prompt, /"checks":\{"status":7\}/);
          return { text: 'Both tests are still failing. No integration.' };
        }
        assert.match(prompt, /\+test-codex/);
        assert.match(prompt, /\+test-grok /);
        assert.match(prompt, /"overlaps":\[\{"path":"shared.txt"/);
        assert.match(prompt, /"projectTests":\{"design":\{"status":7\}\}/);
        reviewed = true;
        return { text: JSON.stringify({ summary: 'Resolve shared.txt before integration.', repairTaskIds: ['checks', 'checks', 'invalid'] }) };
      }
      assert.match(prompt, /base\\n/);
      if (prompt.includes('"correction":')) {
        correctionCount += 1;
        assert.equal(model, 'test-grok');
        assert.match(prompt, /trailing whitespace/);
        return { text: JSON.stringify({ files: [{ path: 'shared.txt', content: 'test-grok-fixed\n' }] }) };
      }
      const suffix = model === 'test-grok' ? ' ' : '';
      return { text: JSON.stringify({ files: [{ path: 'shared.txt', content: `${model}${suffix}\n` }] }) };
    },
  });
  t.after(() => rmSync(outcome.project.workspace, { recursive: true, force: true }));
  assert.ok(reviewed);
  assert.equal(outcome.status, 'needs-review');
  assert.deepEqual(outcome.project.overlaps, [{ path: 'shared.txt', tasks: ['design', 'checks'] }]);
  assert.equal(outcome.project.checks.design.status, 7);
  assert.equal(correctionCount, 1);
  assert.equal(testApprovals, 2);
  assert.equal(outcome.project.correctionChecks.checks.checks.status, 7);
  assert.equal(outcome.project.finalReview.result.text, 'Both tests are still failing. No integration.');
  assert.deepEqual(outcome.project.open.map(({ id, testExit }) => ({ id, testExit })), [
    { id: 'design', testExit: 7 }, { id: 'checks', testExit: 7 },
  ]);
  assert.equal(outcome.workers[1].status, 'needs-repair');
  assert.match(outcome.workers[1].result.evidence.diffCheck.output, /trailing whitespace/);
  for (const [index, { result }] of outcome.workers.entries()) {
    assert.notEqual(result.evidence.worktree, repo);
    assert.equal(readFileSync(join(result.evidence.worktree, 'shared.txt'), 'utf8'), ['test-codex\n', 'test-grok \n'][index]);
  }
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'uncommitted-local-edit\n');
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);

  await assert.rejects(runPlanningSession({ ...config, files: ['../private.txt'] }), /paths relative to the project/);
  const denied = await runPlanningSession({ ...config, approve: () => false, async runTurn({ prompt }) {
    assert.match(prompt, /^You are coordinating/);
    return { text: JSON.stringify({ tasks: projectTasks }) };
  } });
  assert.equal(denied.status, 'not-approved');
  assert.deepEqual(denied.workers, []);
});

test('reconciles overlapping proposals only after approval and verifies the combined worktree', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'lab-m4-integration-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'user.name=Lab-M4', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet', '--template=');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'test integration snapshot');
  const plan = [
    { id: 'one', worker: 0, task: 'Add alpha', dependsOn: [], files: ['shared.txt'] },
    { id: 'two', worker: 1, task: 'Add beta', dependsOn: [], files: ['shared.txt'] },
  ];
  const replacement = (content) => ({ files: [{ path: 'shared.txt', content }] });
  let conflictAllowed = false;
  let candidateAllowed = false;
  let combinedChecked = false;
  let conflictsResolved = 0;
  const config = {
    ...assignment, project: repo, files: ['shared.txt'], approve: () => true,
    check: { executable: join(repo, 'test.exe'), args: ['check.mjs'] },
    approveTests(_command, changes) {
      if (changes[0].id === 'combined') assert.ok(candidateAllowed);
      return true;
    },
    async runCheck({ worktree }) {
      if (worktree.includes('integration-check')) {
        assert.equal(readFileSync(join(worktree, 'shared.txt'), 'utf8'), 'base\nalpha\nbeta\n');
        combinedChecked = true;
      }
      return { status: 0 };
    },
    async runTurn({ prompt, model }) {
      if (prompt.startsWith('You are coordinating')) return { text: JSON.stringify({ tasks: plan }) };
      if (prompt.startsWith('Review these real Git diffs')) return { text: '{"summary":"Both changes add a line.","repairTaskIds":[]}' };
      if (prompt.startsWith('Reconcile overlapping')) {
        assert.ok(conflictAllowed);
        assert.match(prompt, /alpha/);
        assert.match(prompt, /beta/);
        conflictsResolved += 1;
        return { text: JSON.stringify({ rationale: 'Kept both additions in order.', ...replacement('base\nalpha\nbeta\n') }) };
      }
      return { text: JSON.stringify(replacement(model === 'test-codex' ? 'base\nalpha\n' : 'base\nbeta\n')) };
    },
    approveIntegration({ rationale, changes }) {
      assert.match(rationale, /both additions/);
      assert.match(changes[0].diff, /\+alpha\n\+beta/);
      candidateAllowed = true;
      return true;
    },
  };
  const denied = await runPlanningSession({ ...config, approveConflicts: () => false });
  t.after(() => rmSync(denied.project.workspace, { recursive: true, force: true }));
  assert.equal(denied.project.integration.status, 'conflicts-not-approved');
  assert.equal(conflictsResolved, 0);
  assert.equal(candidateAllowed, false);
  const approved = await runPlanningSession({
    ...config, approveConflicts({ overlaps }) {
      assert.deepEqual(overlaps, [{ path: 'shared.txt', tasks: ['one', 'two'] }]);
      conflictAllowed = true;
      return true;
    },
  });
  t.after(() => rmSync(approved.project.workspace, { recursive: true, force: true }));
  assert.equal(approved.project.integration.status, 'verified');
  assert.equal(conflictsResolved, 1);
  assert.ok(combinedChecked);
  assert.deepEqual(approved.project.remainingOverlaps, []);
  assert.deepEqual(approved.project.open, []);
  assert.equal(readFileSync(join(repo, 'shared.txt'), 'utf8'), 'base\n');
});
