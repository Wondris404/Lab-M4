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
import { handleRequest } from '../src/service/protocol.js';

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

it('scans only supported history directories under a custom Codex home', async () => {
  const dir = await testTempDir('codex-discovery-');
  const home = join(dir, 'custom-home');
  const sessions = join(home, 'sessions');
  const archive = join(home, 'archived_sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archive);
  const text = Buffer.from(decompress(await readFile(fixture))).toString('utf8');
  await writeFile(join(sessions, 'rollout.jsonl'), text);
  await copyFile(fixture, join(archive, 'rollout.jsonl.zst'));
  await writeFile(join(home, 'unrelated.jsonl'), text + event(20, 19) + '\n');
  await writeFile(join(sessions, 'auth.jsonl'), text + event(30, 29) + '\n');
  const response = await handleRequest({
    version: 1, requestId: 'history', method: 'scan',
    params: { agent: 'codex', path: home, codexHome: true, cachePath: join(dir, 'cache.sqlite') },
  });
  expect(response.result.records.map(({ input }) => input)).toEqual([10]);
});

it('keeps Codex usage before and after an oversized transcript line', async () => {
  const dir = await testTempDir('codex-large-line-');
  const path = join(dir, 'rollout.jsonl');
  const text = Buffer.from(decompress(await readFile(fixture))).toString('utf8');
  await writeFile(path, text + 'x'.repeat(1024 * 1024 + 1) + '\n' + event(40, 30) + '\n');
  const full = await codexParser.parse(path);
  const incremental = await scanCached(codexParser, path, join(dir, 'cache.sqlite'));
  for (const result of [full, incremental]) {
    expect(result.records.map(({ inputTokens }) => inputTokens)).toEqual([10, 30]);
    expect(result.partial).toBe(true);
  }
});

it('distinguishes rollout IDs even when the session field is shared', async () => {
  const dir = await testTempDir('codex-rollouts-');
  const source = join(dir, 'sessions');
  await mkdir(source);
  for (const id of ['first-rollout', 'second-rollout']) {
    const meta = JSON.stringify({ type: 'session_meta', payload: { id, session_id: 'shared' } });
    await writeFile(join(source, id + '.jsonl'), [meta, event(10, 10), ''].join('\n'));
  }
  for (const result of [await codexParser.parse(source), await scanCached(codexParser, source, join(dir, 'cache.sqlite'))]) {
    expect(result.records).toHaveLength(2);
    expect(new Set(result.records.map(({ sessionId }) => sessionId)).size).toBe(2);
  }
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
