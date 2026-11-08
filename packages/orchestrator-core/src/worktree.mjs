import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = ['-c', 'core.autocrlf=false', '-c', 'user.email=lab-m4@example.invalid', '-c', 'user.name=Lab-M4'];

function runGit(repo, args) {
  const result = spawnSync('git', [...git, ...args], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'git failed');
  }
  return result.stdout;
}

export function createIsolatedWorktrees(count) {
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Invalid worktree count');
  const parent = mkdtempSync(join(tmpdir(), 'lab-m4-wt-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  runGit(repo, ['init']);
  runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
  const trees = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(parent, `tree-${index}`);
    if (existsSync(path)) throw new Error('Worktree path collided');
    runGit(repo, ['worktree', 'add', '--detach', path, 'HEAD']);
    trees.push(path);
  }
  return { parent, repo, trees };
}

export function removeWorkspace(parent) {
  rmSync(parent, { recursive: true, force: true });
}

export function captureWorkerDiff(worktree, body) {
  if (body !== 'draft\n' && body !== 'corrected\n') throw new Error('Unexpected synthetic body');
  writeFileSync(join(worktree, 'task.txt'), body);
  writeFileSync(join(worktree, 'check.mjs'), "import { readFileSync } from 'node:fs';\nif (readFileSync('task.txt', 'utf8') !== 'corrected\\n') process.exit(1);\n");
  runGit(worktree, ['add', '-N', 'task.txt']);
  const diff = runGit(worktree, ['diff', '--', 'task.txt']).replaceAll('\r\n', '\n');
  const test = spawnSync(process.execPath, ['check.mjs'], { cwd: worktree, encoding: 'utf8' });
  return { diff, test: { status: test.status } };
}

export function captureSyntheticAttempt(attempt) {
  const workspace = createIsolatedWorktrees(1);
  try {
    return captureWorkerDiff(workspace.trees[0], attempt === 1 ? 'draft\n' : 'corrected\n');
  } finally {
    removeWorkspace(workspace.parent);
  }
}
