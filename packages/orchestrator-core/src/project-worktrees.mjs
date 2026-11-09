import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxBytes = 24 * 1024;
let gitExecutable;

async function locateGit() {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    if ((await stat(path).catch(() => null))?.isFile()) return realpath(path);
  }
  throw new Error('Git executable is missing from PATH');
}

async function git(cwd, args, signal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  gitExecutable ??= locateGit();
  const { stdout } = await exec(await gitExecutable, [
    '--literal-pathspecs', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', ...args,
  ], { cwd, env, signal, windowsHide: true, encoding: 'buffer', maxBuffer: 512 * 1024 });
  return decode.decode(stdout);
}

export function checkScope(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 12)
    throw new Error('Choose 1 to 12 text files for this run');
  const unique = new Set();
  const normalized = paths.map((path) => typeof path === 'string' ? path.replaceAll('\\', '/') : path);
  for (const path of normalized) {
    if (typeof path !== 'string' || path.length > 180 || path.split('/').some((part) =>
      !part || /[<>:"\\|?*\p{Cc}]|[. ]$/u.test(part) || /^(?:\.git|\.?git~[0-9]+)$/i.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || unique.has(path.toLowerCase())) {
      throw new Error('Use distinct, portable paths relative to the project');
    }
    unique.add(path.toLowerCase());
  }
  return normalized;
}

async function readFolderFile(folder, path, remaining, signal) {
  const source = join(folder, path);
  const info = await lstat(source).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      throw new Error(`Súbor „${path}“ sa vo vybranom priečinku nenašiel. Použi tlačidlo „Vybrať súbory“ alebo zadaj cestu aj s podpriečinkom.`);
    throw error;
  });
  const resolved = await realpath(source);
  const actualPath = relative(folder, resolved).replaceAll('\\', '/');
  const matches = process.platform === 'win32' ? actualPath.toLowerCase() === path.toLowerCase() : actualPath === path;
  if (!matches || !info.isFile())
    throw new Error(`Choose a regular file inside the selected folder: ${path}`);
  if (info.size > remaining) throw new Error('Selected files must contain at most 24 KiB of UTF-8 text');
  return decode.decode(await readFile(resolved, { signal }));
}

export async function readProject(project, paths, signal) {
  if (typeof project !== 'string' || !isAbsolute(project)) throw new Error('Choose an absolute project path');
  const scopedPaths = checkScope(paths);
  const folder = await realpath(project);
  let repo;
  let base;
  try {
    repo = await realpath((await git(folder, ['rev-parse', '--show-toplevel'], signal)).trimEnd());
    base = (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  } catch (error) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(error.stderr) || !/not a git repository|detected dubious ownership|Needed a single revision/.test(error.stderr.toString())) throw error;
  }
  if (base && repo === folder) {
    for (const path of scopedPaths) {
      const entry = await git(repo, ['ls-tree', '--full-tree', '-z', base, '--', path], signal);
      if (!/^100(?:644|755) blob [0-9a-f]+\t[^\0]+\0$/.test(entry) || !entry.endsWith(`\t${path}\0`)) {
        base = null;
        break;
      }
    }
  } else {
    base = null;
  }
  const entries = new Map();
  let bytes = 0;
  for (const path of scopedPaths) {
    const text = base ? await git(repo, ['show', `${base}:${path}`], signal)
      : await readFolderFile(folder, path, maxBytes - bytes, signal);
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes || text.includes('\0')) throw new Error('Approved files must contain at most 24 KiB of UTF-8 text');
    entries.set(path, text);
  }
  return { repo: base ? repo : folder, base: base ?? null, entries };
}

export async function createProjectWorkspace(snapshot, signal) {
  const root = await mkdtemp(join(tmpdir(), 'lab-m4-project-'));
  const gitDir = join(root, 'git');
  try {
    await mkdir(gitDir);
    if (snapshot.base) {
      await git(gitDir, ['init', '--bare', '--template='], signal);
      await git(gitDir, ['fetch', '--depth=1', '--no-tags', '--', snapshot.repo, snapshot.base], signal);
    } else {
      await git(gitDir, ['init', '--template='], signal);
      await git(gitDir, ['config', 'core.whitespace', 'cr-at-eol'], signal);
      const info = join(gitDir, '.git', 'info');
      await mkdir(info, { recursive: true });
      await writeFile(join(info, 'attributes'), '* -text -filter -ident -working-tree-encoding !eol\n');
      for (const [path, content] of snapshot.entries) {
        signal?.throwIfAborted();
        const file = join(gitDir, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
      }
      await git(gitDir, ['add', '--force', '--', ...snapshot.entries.keys()], signal);
      await git(gitDir, ['-c', 'user.name=Lab-M4', '-c', 'user.email=local@lab-m4.invalid',
        'commit', '--quiet', '-m', 'Selected project files'], signal);
      snapshot.base = (await git(gitDir, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
    }
  } catch (cause) {
    throw new Error(`Could not prepare isolated Git workspace at ${root}`, { cause });
  }
  return root;
}

export async function captureProjectDiff(root, snapshot, id, files, response, signal, group = 'workers') {
  let patch;
  try { patch = JSON.parse(response); }
  catch { throw new Error('Worker did not return a JSON file proposal'); }
  if (!Array.isArray(patch?.files) || patch.files.length < 1 || patch.files.length > files.length)
    throw new Error('Worker must return at least one approved file');
  const replacements = new Map();
  let bytes = 0;
  for (const entry of patch.files) {
    const { path, content } = entry ?? {};
    if (!files.includes(path) || replacements.has(path) || typeof content !== 'string' || content.includes('\0'))
      throw new Error('Worker returned an invalid or unapproved file');
    bytes += Buffer.byteLength(content);
    if (bytes > maxBytes) throw new Error('Worker file proposal exceeds 24 KiB');
    replacements.set(path, content);
  }
  for (const [path, content] of replacements) {
    if (content === snapshot.entries.get(path)) replacements.delete(path);
  }
  if (!replacements.size) throw new Error('Worker proposed no changes');

  const worktree = join(root, group, id);
  await git(join(root, 'git'), ['worktree', 'add', '--quiet', '--detach', worktree, snapshot.base], signal);
  const resolvedTree = await realpath(worktree);
  for (const path of replacements.keys()) {
    const target = join(worktree, path);
    const resolved = relative(resolvedTree, await realpath(target)).replaceAll('\\', '/');
    if (resolved !== path || !(await lstat(target)).isFile() ||
        decode.decode(await readFile(target)) !== snapshot.entries.get(path)) {
      throw new Error(`Worker checkout does not match the approved snapshot: ${path}`);
    }
  }
  for (const [path, content] of replacements) {
    signal?.throwIfAborted();
    await writeFile(join(worktree, path), content, 'utf8');
  }
  const options = ['--no-ext-diff', '--no-textconv', 'HEAD', '--', ...replacements.keys()];
  const diff = await git(worktree, ['diff', ...options], signal);
  const changed = (await git(worktree, ['diff', '--name-only', '-z', ...options], signal)).split('\0').filter(Boolean);
  if (!changed.length) throw new Error('Git found no changes in the worker proposal');
  let diffCheck;
  try {
    await git(worktree, ['diff', '--check', ...options], signal);
    diffCheck = { status: 0, output: '' };
  } catch (error) {
    if (error.code !== 2 || !Buffer.isBuffer(error.stdout)) throw error;
    diffCheck = { status: error.code, output: decode.decode(error.stdout) };
  }
  return { worktree, diff, changed, diffCheck };
}

export function findOverlaps(results) {
  const byPath = new Map();
  for (const { id, result } of results) {
    for (const path of result?.evidence?.changed ?? []) {
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(id);
    }
  }
  return [...byPath].filter(([, ids]) => ids.length > 1).map(([path, tasks]) => ({ path, tasks }));
}
