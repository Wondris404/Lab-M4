import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';
import { opencodeParser } from '../src/parsers/opencode.js';
import { scanCached } from '../src/service/cache.js';
import { testTempDir } from './test-temp.js';

const run = (db: sqlite3.Database, sql: string) =>
  new Promise<void>((resolve, reject) =>
    db.run(sql, (error) => (error ? reject(error) : resolve())),
  );
const close = (db: sqlite3.Database) =>
  new Promise<void>((resolve, reject) =>
    db.close((error) => (error ? reject(error) : resolve())),
  );

it('skips a rollback journal and reads the database after the writer releases it', async () => {
  const dir = await testTempDir('sqlite-lock-');
  const sourceDir = join(dir, 'source');
  await mkdir(sourceDir);
  const path = join(sourceDir, 'opencode.db');
  const cache = join(dir, 'cache.sqlite');
  const writer = new sqlite3.Database(path);
  try {
    await run(
      writer,
      'CREATE TABLE message(session_id TEXT, time_created INTEGER, data TEXT)',
    );
    await run(
      writer,
      'CREATE TABLE session(id TEXT,time_created INTEGER,tokens_input INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,cost REAL)',
    );
    await run(writer, 'BEGIN EXCLUSIVE');
    await run(writer, "INSERT INTO message VALUES ('test', 1, '{}')");
    const names = (await readdir(sourceDir)).sort();
    const locked = await scanCached(opencodeParser, path, cache);
    expect(locked.partial).toBe(true);
    expect(locked.warnings).toBe(1);
    expect(locked.records).toEqual([]);
    expect((await readdir(sourceDir)).sort()).toEqual(names);
    await run(writer, 'ROLLBACK');
    const unlocked = await scanCached(opencodeParser, path, cache);
    expect(unlocked.partial).not.toBe(true);
    expect(unlocked.warnings).toBe(0);
    expect(await readdir(sourceDir)).toEqual(['opencode.db']);
  } finally {
    await close(writer);
  }
});
