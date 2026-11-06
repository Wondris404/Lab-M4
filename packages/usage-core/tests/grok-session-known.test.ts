import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';
import { grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
import { handleRequest } from '../src/service/protocol.js';
import { testTempDir } from './test-temp.js';

const event = (sid: string) => JSON.stringify({
  sid,
  ts: '2025-01-01T00:00:00Z',
  msg: 'shell.turn.inference_done',
  ctx: { loop_index: 1, prompt_tokens: 10, cached_prompt_tokens: 0, completion_tokens: 2, reasoning_tokens: 0 },
});
const contents = [
  event('unlinked-one'),
  event('unlinked-two'),
  JSON.stringify({ sid: 'linked', ctx: { session_id: 'synthetic-session' } }),
  event('linked'),
  '',
].join('\n');

// A valid zstd single-segment frame containing one raw block; no extra encoder
// dependency or access to a real provider log is needed for the cache test.
function rawZstd(input: string): Buffer {
  const data = Buffer.from(input);
  const frame = Buffer.alloc(12);
  frame.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
  frame.writeUInt32LE(data.length, 5);
  frame.writeUIntLE(data.length * 8 + 1, 9, 3);
  return Buffer.concat([frame, data]);
}

async function withDatabase<T>(path: string, operation: (db: sqlite3.Database) => Promise<T>): Promise<T> {
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(path, (error) => error ? reject(error) : resolve(instance));
  });
  try { return await operation(db); }
  finally { await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); }
}

it('exposes unknown session status without inventing a session from the trace', async () => {
  const dir = await testTempDir('grok-session-known-');
  const path = join(dir, 'grok.jsonl');
  const cachePath = join(dir, 'cache.sqlite');
  await writeFile(path, contents);
  const request = { version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'grok-build', path, cachePath } };
  const result = (await handleRequest(request)).result;
  expect(result.records.map((record) => record.sessionKnown)).toEqual([false, false, true]);
  expect(result.records[0]?.session).toBe(result.records[1]?.session);
  expect(result.records[2]?.session).not.toBe(result.records[0]?.session);
  expect((await handleRequest(request)).result.records.map((record) => record.sessionKnown)).toEqual([false, false, true]);
});

it('does not reuse v3 unmarked JSONL cursor results', async () => {
  const dir = await testTempDir('grok-session-cursor-');
  const path = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(path, contents);
  const result = await scanCached(grokBuildParser, path, cache);
  const stale = structuredClone(result);
  for (const record of stale.records) delete record.sessionKnown;
  const key = createHash('sha256').update(`grok-build\0${await realpath(path)}`).digest('hex') + ':v3';
  await withDatabase(cache, async (db) => {
    await new Promise<void>((resolve, reject) => db.run(
      'UPDATE grok_cursor SET id = ?, result = ?', [key, JSON.stringify(stale)],
      (error) => error ? reject(error) : resolve(),
    ));
  });
  expect((await scanCached(grokBuildParser, path, cache)).records.map((record) => record.sessionKnown)).toEqual([false, false, undefined]);
});

it('does not reuse old unmarked compressed Grok scan results', async () => {
  const dir = await testTempDir('grok-session-compressed-');
  const path = join(dir, 'grok.jsonl.zst');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(path, rawZstd(contents));
  const result = await scanCached(grokBuildParser, path, cache);
  expect(result.records.map((record) => record.sessionKnown)).toEqual([false, false, undefined]);
  await withDatabase(cache, async (db) => {
    const row = await new Promise<{ signature: string; result: string }>((resolve, reject) => db.get(
      'SELECT signature, result FROM scan_cache',
      (error, value) => error ? reject(error) : resolve(value as { signature: string; result: string }),
    ));
    const signature = JSON.parse(row.signature) as unknown[];
    signature[0] = 9;
    const stale = JSON.parse(row.result) as typeof result;
    for (const record of stale.records) delete record.sessionKnown;
    await new Promise<void>((resolve, reject) => db.run(
      'UPDATE scan_cache SET signature = ?, result = ?', [JSON.stringify(signature), JSON.stringify(stale)],
      (error) => error ? reject(error) : resolve(),
    ));
  });
  expect((await scanCached(grokBuildParser, path, cache)).records.map((record) => record.sessionKnown)).toEqual([false, false, undefined]);
});
