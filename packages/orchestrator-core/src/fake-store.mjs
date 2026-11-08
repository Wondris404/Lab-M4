import { mkdir, lstat, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function directory(parent, name) {
  const path = join(parent, name);
  try { await mkdir(path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      dirname(await realpath(path)) !== await realpath(parent)) throw new Error('Unsafe fake state directory');
  return path;
}
async function storePath() {
  return directory(await directory(root, '.lab-m4'), 'orchestration-fake');
}
function validateId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('Invalid session ID');
}
async function readState(path, id) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Invalid state file');
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (state.id !== id || state.mode !== 'fake' || state.version !== 1 || !Array.isArray(state.events))
    throw new Error('Invalid fake session');
  return state;
}
export async function createSession(state) {
  validateId(state.id);
  const directory = await storePath();
  await writeFile(join(directory, `${state.id}.json`), JSON.stringify(state), { flag: 'wx' });
}
export async function loadSession(id) {
  validateId(id);
  return readState(join(await storePath(), `${id}.json`), id);
}
export async function listSessions() {
  const dir = await storePath();
  const ids = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5)).filter((id) => idPattern.test(id));
  return Promise.all(ids.sort().map((id) => readState(join(dir, `${id}.json`), id)));
}
export async function updateSession(id, update) {
  validateId(id);
  const dir = await storePath();
  const path = join(dir, `${id}.json`), lockPath = join(dir, `${id}.lock`);
  const lock = await open(lockPath, 'wx');
  const lockInfo = await lock.stat();
  try {
    const state = await readState(path, id);
    await update(state);
    const temp = join(dir, `${id}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(state), { flag: 'wx' });
    await rename(temp, path);
    return state;
  } finally {
    await lock.close();
    const info = await lstat(lockPath);
    if (info.dev === lockInfo.dev && info.ino === lockInfo.ino && info.isFile() && !info.isSymbolicLink())
      await unlink(lockPath);
  }
}
