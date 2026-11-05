import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import sqlite3 from 'sqlite3';
import type { Parser, ParseResult } from '../parsers/contracts.js';
import { assertSafeFile, findCodexFiles } from '../parsers/shared.js';

async function lstatIfExists(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Cache normalized data only. Caller must select an application-owned cache path. */
export async function scanCached(parser: Parser, source: string, cachePath: string, force = false): Promise<ParseResult> {
  const original = await lstat(source);
  if (original.isSymbolicLink()) throw new Error('Nepovolený odkaz.');
  const canonical = await realpath(source);
  const key = createHash('sha256').update(`${parser.provider}\0${canonical}`).digest('hex');
  let signature: string;
  if (original.isDirectory() && parser.provider === 'codex') {
    const files: string[] = [];
    for await (const file of findCodexFiles(canonical)) {
      await assertSafeFile(file);
      const info = await lstat(file);
      const fileId = createHash('sha256').update(file).digest('hex');
      files.push(JSON.stringify([fileId, info.size, info.mtimeMs]));
    }
    signature = JSON.stringify([2, files.sort()]);
  } else {
    await assertSafeFile(source);
    const info = await lstat(canonical);
    const wal = await lstatIfExists(`${canonical}-wal`);
    const shm = await lstatIfExists(`${canonical}-shm`);
    if (parser.provider === 'opencode' && (wal || shm)) throw new Error('Live WAL database requires a closed snapshot.');
    signature = JSON.stringify([2, info.size, info.mtimeMs, wal?.size ?? null, wal?.mtimeMs ?? null]);
  }
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(cachePath, (error) => error ? reject(error) : resolve(instance));
  });
  const exec = (sql: string, values: unknown[] = []) => new Promise<void>((resolve, reject) => db.run(sql, values, (e) => e ? reject(e) : resolve()));
  try {
    await exec('CREATE TABLE IF NOT EXISTS scan_cache (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL)');
    const row = await new Promise<{ signature: string; result: string } | undefined>((resolve, reject) => db.get('SELECT signature, result FROM scan_cache WHERE id = ?', [key], (e, value) => e ? reject(e) : resolve(value as { signature: string; result: string } | undefined)));
    if (!force && row?.signature === signature) return JSON.parse(row.result) as ParseResult;
    const result = await parser.parse(canonical);
    // Cache replacement is atomic; no original file is written.
    await exec('INSERT OR REPLACE INTO scan_cache (id, signature, result) VALUES (?, ?, ?)', [key, signature, JSON.stringify(result)]);
    return result;
  } finally {
    await new Promise<void>((resolve, reject) => db.close((e) => e ? reject(e) : resolve()));
  }
}
