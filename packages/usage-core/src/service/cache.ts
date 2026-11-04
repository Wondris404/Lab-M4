import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import sqlite3 from 'sqlite3';
import type { Parser, ParseResult } from '../parsers/contracts.js';
import { assertSafeFile } from '../parsers/shared.js';

/** Cache normalized data only. Caller must select an application-owned cache path. */
export async function scanCached(parser: Parser, source: string, cachePath: string, force = false): Promise<ParseResult> {
  await assertSafeFile(source);
  const canonical = await realpath(source);
  const info = await lstat(canonical);
  const wal = await lstat(`${canonical}-wal`).catch(() => undefined);
  const key = createHash('sha256').update(`${parser.provider}\0${canonical}`).digest('hex');
  const signature = JSON.stringify([1, info.size, info.mtimeMs, wal?.size ?? null, wal?.mtimeMs ?? null]);
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
