import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
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
  expect(
    (await scanCached(grokBuildParser, file, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([10, 20, 30]);
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
