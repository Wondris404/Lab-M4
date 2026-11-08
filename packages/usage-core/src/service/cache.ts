import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import sqlite3 from 'sqlite3';
import { type Parser, type ParseResult } from '../parsers/contracts.js';
import { assertSafeFile, findCodexFiles } from '../parsers/shared.js';
import { normalizeRecord } from './normalize.js';
import { grokAccumulator, grokBuildParser, type GrokCursorState } from '../parsers/grok-build.js';
import { codexParser } from '../parsers/codex.js';
import { codexAccumulator, type CodexCursorState } from '../parsers/codex-cursor.js';
import { scanJsonlAppend } from './grok-cursor.js';
import { scanCodexDirectory } from './codex-directory.js';
import { openCodeSnapshot } from '../parsers/opencode.js';
import { grokHistoryFiles, isGrokHistory } from '../parsers/grok-history.js';

async function lstatIfExists(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Cache normalized data only. Caller must select an application-owned cache path. */
export async function scanCached(parser: Parser, source: string, cachePath: string, force = false, codexHome = false): Promise<ParseResult> {
  const original = await lstat(source);
  if (original.isSymbolicLink()) throw new Error('Nepovolený odkaz.');
  const canonical = await realpath(source);
  const key = createHash('sha256').update(`${parser.provider}\0${canonical}`).digest('hex');
  const grokHistory = parser === grokBuildParser && isGrokHistory(canonical, original.isDirectory());
  const directory = (parser.provider === 'codex' || grokHistory) && original.isDirectory();
  if (!directory) await assertSafeFile(source);
  if (/auth|credential|token|secret|key|login|\.env/i.test(basename(cachePath))) {
    throw new Error('Nepovolená cache.');
  }
  const cacheInfo = await lstatIfExists(cachePath);
  if (cacheInfo && (cacheInfo.isSymbolicLink() || !cacheInfo.isFile())) throw new Error('Nepovolená cache.');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(cachePath, (error) => error ? reject(error) : resolve(instance));
  });
  const exec = (sql: string, values: unknown[] = []) => new Promise<void>((resolve, reject) => db.run(sql, values, (e) => e ? reject(e) : resolve()));
  try {
    await exec('CREATE TABLE IF NOT EXISTS scan_cache (id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL)');
    await exec('CREATE TABLE IF NOT EXISTS cache_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // A random local salt is used only to pseudonymize session IDs; it is not agent auth.
    await exec('INSERT OR IGNORE INTO cache_meta (name, value) VALUES (?, ?)', ['session_salt', randomBytes(32).toString('hex')]);
    const metadata = await new Promise<{ value: string }>((resolve, reject) => db.get('SELECT value FROM cache_meta WHERE name = ?', ['session_salt'], (e, value) => e ? reject(e) : resolve(value as { value: string })));
    const pseudonym = (sessionId: string) => createHmac('sha256', metadata.value).update(`${parser.provider}\0${sessionId}`).digest('hex');
    if (directory && parser === codexParser)
      return await scanCodexDirectory(db, key, canonical, pseudonym, force, codexHome);
    if (parser === grokBuildParser && !grokHistory && original.isFile() && !/\.zst$/i.test(canonical))
      return await scanJsonlAppend(db, `${key}:v2`, canonical, (previous) => grokAccumulator(previous as GrokCursorState | undefined, pseudonym), force);
    if (parser === codexParser && original.isFile() && /\.jsonl$/i.test(canonical))
      return await scanJsonlAppend(db, `${key}:v6`, canonical, (previous) => codexAccumulator(previous as CodexCursorState | undefined, pseudonym), force, true);
    const info = await lstat(canonical);
    const sqlite = parser.provider === 'opencode' ? await openCodeSnapshot(canonical) : undefined;
    const files: string[] = [];
    if (directory) {
      for await (const file of grokHistory ? grokHistoryFiles(canonical) : findCodexFiles(canonical)) {
        await assertSafeFile(file);
        const stat = await lstat(file);
        const fileId = createHash('sha256').update(file).digest('hex');
        files.push(JSON.stringify([fileId, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      }
    }
    const signature = JSON.stringify([10, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, sqlite?.signature, files.sort()]);
    const row = await new Promise<{ signature: string; result: string } | undefined>((resolve, reject) => db.get('SELECT signature, result FROM scan_cache WHERE id = ?', [key], (e, value) => e ? reject(e) : resolve(value as { signature: string; result: string } | undefined)));
    if (!force && !sqlite?.wal && !sqlite?.journal && row?.signature === signature)
      return JSON.parse(row.result) as ParseResult;
    const parsed = await parser.parse(canonical);
    const result = { ...parsed, records: parsed.records.map((record) => ({ ...(grokHistory ? record : normalizeRecord(record)), sessionId: pseudonym(record.sessionId) })), limits: parsed.limits.map((limit) => ({ ...limit, sessionId: pseudonym(limit.sessionId) })) };
    // Cache replacement is atomic; no original file is written.
    if (!result.partial && (!sqlite || sqlite.signature === (await openCodeSnapshot(canonical)).signature))
      await exec('INSERT OR REPLACE INTO scan_cache (id, signature, result) VALUES (?, ?, ?)', [key, signature, JSON.stringify(result)]);
    return result;
  } finally {
    await new Promise<void>((resolve, reject) => db.close((e) => e ? reject(e) : resolve()));
  }
}
