import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
import { testTempDir } from './test-temp.js';

it('retains undercount and partial across malformed JSON, cache reuse and valid appends', async () => {
  const dir = await testTempDir('grok-partial-');
  const path = join(dir, 'usage.jsonl');
  const cache = join(dir, 'cache.sqlite');
  const usage = (n: number) => JSON.stringify({ sid: 'synthetic', ts: `2025-01-01T00:00:0${n}Z`, msg: 'shell.turn.inference_done', ctx: { loop_index: n, prompt_tokens: n * 10, cached_prompt_tokens: 0, completion_tokens: 2, reasoning_tokens: 0 } });
  await writeFile(path, `${usage(1)}\n{broken\n`);
  expect(await grokBuildParser.parse(path)).toMatchObject({ partial: true, countRisk: 'under-count', warnings: 1 });
  const first = await scanCached(grokBuildParser, path, cache);
  expect(first).toMatchObject({ partial: true, countRisk: 'under-count', warnings: 1 });
  expect(first.records).toHaveLength(1);
  expect(await scanCached(grokBuildParser, path, cache)).toEqual(first);
  await appendFile(path, usage(2));
  expect((await scanCached(grokBuildParser, path, cache)).records).toHaveLength(1);
  await appendFile(path, '\n');
  const next = await scanCached(grokBuildParser, path, cache);
  expect(next).toMatchObject({ partial: true, countRisk: 'under-count', warnings: 1 });
  expect(next.records.map(r => r.inputTokens)).toEqual([10, 20]);
  expect(await scanCached(grokBuildParser, path, cache, true)).toEqual(next);
});
