import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';
import { grokAccumulator, grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
import { emptyResult } from '../src/parsers/contracts.js';
import { testTempDir } from './test-temp.js';

const context = (session: string) => JSON.stringify({ sid: 'same-trace', ctx: { session_id: session } });
const usage = JSON.stringify({
  sid: 'same-trace',
  ts: '2025-01-01T00:00:00Z',
  msg: 'shell.turn.inference_done',
  ctx: { loop_index: 1, prompt_tokens: 10, cached_prompt_tokens: 0, completion_tokens: 2, reasoning_tokens: 0 },
});

it('keeps identical-looking events when a trace is reassociated with a different session', async () => {
  const accumulator = grokAccumulator();
  for (const line of [context('first'), usage, usage, context('second'), usage, usage]) accumulator.consume(line);
  expect(accumulator.result.records.map((record) => record.sessionId)).toEqual(['first', 'second']);
  expect(accumulator.result.records.map((record) => record.inputTokens)).toEqual([10, 10]);
});

it('invalidates a cursor created with the previous deduplication semantics', async () => {
  const dir = await testTempDir('grok-session-');
  const source = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(source, [context('first'), usage, context('second'), usage, ''].join('\n'));
  const fresh = await scanCached(grokBuildParser, source, cache);
  expect(fresh.records).toHaveLength(2);

  // Simulate an otherwise valid, unchanged v2 cursor created by the old parser.
  // A v3 scan must not reuse this stale result even if file metadata matches.
  const oldKey = createHash('sha256').update(`grok-build\0${await realpath(source)}`).digest('hex') + ':v2';
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(cache, (error) => error ? reject(error) : resolve(instance));
  });
  try {
    await new Promise<void>((resolve, reject) => db.run(
      'UPDATE grok_cursor SET id = ?, result = ?',
      [oldKey, JSON.stringify(emptyResult())],
      (error) => error ? reject(error) : resolve(),
    ));
  } finally {
    await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
  const rescanned = await scanCached(grokBuildParser, source, cache);
  expect(rescanned.records).toHaveLength(2);
  expect(new Set(rescanned.records.map((record) => record.sessionId)).size).toBe(2);
});
