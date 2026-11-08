import { appendFile, open, readFile, rename, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';
import { grokAccumulator, grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
import { scanJsonlAppend } from '../src/service/grok-cursor.js';
import { testTempDir } from './test-temp.js';

const line = (value: unknown) => JSON.stringify(value);
const context = (session: string) =>
  line({
    sid: 'synthetic-trace',
    ctx: { session_id: session, model_id: 'test-model' },
  });
const usage = (n: number) =>
  line({
    sid: 'synthetic-trace',
    ts: `2025-01-01T00:00:0${n}Z`,
    msg: 'shell.turn.inference_done',
    ctx: {
      loop_index: n,
      prompt_tokens: n * 10,
      cached_prompt_tokens: 1,
      completion_tokens: 2,
      reasoning_tokens: 1,
    },
  });

it('scans appends, defers partial lines, and rescans on truncation and rotation', async () => {
  const dir = await testTempDir('grok-cursor-');
  const file = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(
    file,
    `${context('synthetic-private-session')}\n${usage(1)}\n${usage(2)}`,
  );
  const initial = await scanCached(grokBuildParser, file, cache);
  expect(initial.records.map((item) => item.inputTokens)).toEqual([10]);
  expect(initial.warnings).toBe(0);
  await appendFile(file, '\n');
  const appended = await scanCached(grokBuildParser, file, cache);
  expect(appended.records.map((item) => item.inputTokens)).toEqual([10, 20]);
  expect(appended.records[1]?.model).toBe('unknown');
  expect(appended.records[1]?.warnings).toContain('MODEL_UNVERIFIED');
  expect(appended.records[1]?.sessionId).toBe(appended.records[0]?.sessionId);
  await appendFile(file, `${usage(2)}\n${usage(3)}\n`);
  const ambiguous = await scanCached(grokBuildParser, file, cache);
  expect(ambiguous.records.map((item) => item.inputTokens)).toEqual([10, 20, 20, 30]);
  expect(ambiguous).toMatchObject({ partial: true, warnings: 1 });
  expect(ambiguous.warningDetails?.[0]).toContain('dvojité započítanie');
  expect(ambiguous.countRisk).toBe('double-count');
  expect(await scanCached(grokBuildParser, file, cache)).toEqual(ambiguous);
  await appendFile(file, '{broken\n');
  const damaged = await scanCached(grokBuildParser, file, cache);
  expect(damaged).toMatchObject({ partial: true, warnings: 2, countRisk: 'both' });
  expect(damaged.records).toEqual(ambiguous.records);
  expect(
    (await readFile(cache)).includes(Buffer.from('synthetic-private-session')),
  ).toBe(false);
  expect((await readFile(cache)).includes(Buffer.from('synthetic-trace'))).toBe(
    false,
  );
  // Rewriting to a larger size must not be mistaken for an append.
  await writeFile(
    file,
    `${context('new-session')}\n${usage(4)}\n${' '.repeat(1500)}\n`,
  );
  expect(
    (await scanCached(grokBuildParser, file, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([40]);
  await writeFile(file, `${context('truncated-session')}\n${usage(5)}\n`);
  expect(
    (await scanCached(grokBuildParser, file, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([50]);
  await rename(file, join(dir, 'rotated.jsonl'));
  await writeFile(file, `${context('another-session')}\n${usage(6)}\n`);
  expect(
    (await scanCached(grokBuildParser, file, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([60]);
});

it('invalidates an old rewrite outside the last 4 KiB followed by an append', async () => {
  const dir = await testTempDir('grok-prefix-');
  const file = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  const content = `${context('synthetic-session')}\n${usage(1)}\n${' '.repeat(6000)}\n`;
  await writeFile(file, content);
  expect((await scanCached(grokBuildParser, file, cache)).records[0]?.inputTokens).toBe(10);
  const original = Buffer.from(content);
  const index = original.indexOf(Buffer.from('"prompt_tokens":10'));
  expect(index).toBeGreaterThanOrEqual(0);
  const handle = await open(file, 'r+');
  try {
    await handle.write(Buffer.from('"prompt_tokens":90'), 0, 18, index);
  } finally {
    await handle.close();
  }
  await appendFile(file, `${usage(2)}\n`);
  const cached = await scanCached(grokBuildParser, file, cache);
  const full = await grokBuildParser.parse(file);
  expect(cached.records.map((record) => record.inputTokens)).toEqual([90, 20]);
  expect(cached.records.map((record) => record.inputTokens)).toEqual(full.records.map((record) => record.inputTokens));
});

it('defers a split UTF-8 character across append and read-buffer boundaries', async () => {
  const dir = await testTempDir('grok-utf8-');
  const file = join(dir, 'grok.jsonl');
  const reference = join(dir, 'reference.jsonl');
  const cache = join(dir, 'cache.sqlite');
  const metadata = Buffer.from(context('syntetická-🐱'));
  const split = metadata.indexOf(Buffer.from('🐱')) + 2;
  const padding = Buffer.from(`${' '.repeat(64 * 1024 - split - 1)}\n`);
  await writeFile(file, Buffer.concat([padding, metadata.subarray(0, split)]));
  expect((await scanCached(grokBuildParser, file, cache)).records).toEqual([]);

  await appendFile(file, Buffer.concat([metadata.subarray(split), Buffer.from(`\n${usage(1)}\n`)]));
  await writeFile(reference, Buffer.concat([metadata, Buffer.from(`\n${usage(1)}\n`)]));
  const appended = await scanCached(grokBuildParser, file, cache);
  expect(appended.warnings).toBe(0);
  expect(appended.records).toHaveLength(1);
  expect(appended.records).toEqual((await scanCached(grokBuildParser, reference, cache)).records);
  expect((await scanCached(grokBuildParser, file, cache, true)).records).toEqual(appended.records);
});

it('keeps a stable Grok prefix before an oversized row without moving the persisted cursor', async () => {
  const dir = await testTempDir('grok-oversized-');
  const file = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  const original = `${context('synthetic-session')}\n${usage(1)}\n${usage(1)}\n`;
  await writeFile(file, original);
  expect((await scanCached(grokBuildParser, file, cache)).countRisk).toBe('double-count');
  await appendFile(file, `${usage(2)}\n${'x'.repeat(1024 * 1024 + 1)}\n${usage(3)}\n`);
  const partial = await scanCached(grokBuildParser, file, cache);
  expect(partial.records.map((record) => record.inputTokens)).toEqual([10, 10, 20]);
  expect(partial).toMatchObject({ partial: true, countRisk: 'both', warnings: 2 });
  expect(await scanCached(grokBuildParser, file, cache, true)).toEqual(partial);
  const db = new sqlite3.Database(cache);
  try {
    const row = await new Promise<{ offset: number }>((resolve, reject) => db.get(
      'SELECT offset FROM grok_cursor', (error, value) => error ? reject(error) : resolve(value as { offset: number }),
    ));
    expect(row.offset).toBe(Buffer.byteLength(original));
  } finally {
    await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
  await writeFile(file, `${original}${usage(2)}\n${usage(3)}\n`);
  expect((await scanCached(grokBuildParser, file, cache)).records.map((record) => record.inputTokens))
    .toEqual([10, 10, 20, 30]);
});

it.each([false, true])('does not publish a changing cursor snapshot with oversized line = %s', async (oversized) => {
  const dir = await testTempDir('grok-live-append-');
  const file = join(dir, 'grok.jsonl');
  await writeFile(file, `${context('synthetic-session')}\n${usage(1)}\n`);
  if (oversized) await appendFile(file, `${'x'.repeat(1024 * 1024 + 1)}\n`);
  const db = new sqlite3.Database(join(dir, 'cache.sqlite'));
  try {
    let appended = false;
    const changing = await scanJsonlAppend(db, 'synthetic', file, () => {
      const accumulator = grokAccumulator();
      return {
        ...accumulator,
        consume(line) {
          accumulator.consume(line);
          if (!appended) {
            appended = true;
            appendFileSync(file, `${usage(2)}\n`);
          }
        },
      };
    }, false);
    expect(changing).toMatchObject({ partial: true, records: [] });
    const stable = await scanJsonlAppend(db, 'synthetic', file, () => grokAccumulator(), false);
    expect(stable.records.map((record) => record.inputTokens)).toEqual(oversized ? [10] : [10, 20]);
  } finally {
    await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
});
