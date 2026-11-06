import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decompress } from 'fzstd';
import { expect, it } from 'vitest';
import { codexParser } from '../src/parsers/codex.js';
import { scanCached } from '../src/service/cache.js';
import { testTempDir } from './test-temp.js';

const fixture = resolve(
  'packages/usage-core/fixtures/synthetic/codex.jsonl.zst',
);
const event = (total: number, last: number) =>
  JSON.stringify({
    timestamp: '2025-01-02T00:00:00Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: {
          input_tokens: last,
          cached_input_tokens: 1,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
      },
    },
  });

it('increments Codex directory files and deduplicates across plain and compressed files', async () => {
  const dir = await testTempDir('codex-directory-');
  const source = join(dir, 'sessions');
  const cache = join(dir, 'cache.sqlite');
  await mkdir(source);
  const text = Buffer.from(decompress(await readFile(fixture))).toString(
    'utf8',
  );
  const a = join(source, 'a.jsonl'),
    b = join(source, 'b.jsonl');
  await writeFile(a, text);
  await writeFile(b, text);
  await copyFile(fixture, join(source, 'archive.jsonl.zst'));
  expect(
    (await scanCached(codexParser, source, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([10]);
  await appendFile(a, event(50, 5));
  expect(
    (await scanCached(codexParser, source, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([10]);
  await appendFile(a, '\n');
  const incremental = await scanCached(codexParser, source, cache);
  const full = await codexParser.parse(source);
  const normalized = (records: typeof full.records) =>
    records.map((record) => ({ ...record, sessionId: 'masked' }));
  expect(normalized(incremental.records)).toEqual(normalized(full.records));
  expect(incremental.records.map((item) => item.inputTokens)).toEqual([10, 5]);
  await rename(a, join(dir, 'moved.jsonl'));
  expect(
    (await scanCached(codexParser, source, cache)).records.map(
      (item) => item.inputTokens,
    ),
  ).toEqual([10]);
  expect((await readFile(cache)).includes(Buffer.from('sess-test-1'))).toBe(
    false,
  );
});
