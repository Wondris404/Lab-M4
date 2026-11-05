import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { codexParser } from '../src/parsers/codex.js';
import { scanCached } from '../src/service/cache.js';
import { testTempDir } from './test-temp.js';

const row = (value: unknown) => JSON.stringify(value);
const usage = (total: number, last: number) =>
  row({
    timestamp: '2025-01-01T00:00:00Z',
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
      rate_limits: {
        primary: { used_percent: 20, window_minutes: 60, resets_at: 123456 },
      },
    },
  });
const prefix = (id: string) =>
  [
    row({ type: 'session_meta', payload: { id } }),
    row({
      type: 'turn_context',
      payload: { model: 'test-model', speed: 'fast' },
    }),
  ].join('\n') + '\n';

it('incrementally parses Codex last usage across append, partial line, truncate and rotation', async () => {
  const dir = await testTempDir('codex-cursor-');
  const path = join(dir, 'codex.jsonl');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(
    path,
    prefix('synthetic-codex-session') + usage(100, 10) + '\n' + usage(150, 5),
  );
  const first = await scanCached(codexParser, path, cache);
  expect(first.records.map((record) => record.inputTokens)).toEqual([10]);
  expect(first.limits).toHaveLength(1);
  await appendFile(path, '\n' + usage(150, 5) + '\n' + usage(180, 3) + '\n');
  const appended = await scanCached(codexParser, path, cache);
  expect(appended.records.map((record) => record.inputTokens)).toEqual([
    10, 5, 3,
  ]);
  expect(appended.limits).toHaveLength(4);
  expect(appended.records[1]?.model).toBe('test-model');
  const full = await codexParser.parse(path);
  expect(appended.records.map((record) => ({ ...record, sessionId: 'masked' })))
    .toEqual(full.records.map((record) => ({ ...record, sessionId: 'masked' })));
  expect(
    (await readFile(cache)).includes(Buffer.from('synthetic-codex-session')),
  ).toBe(false);
  await writeFile(path, prefix('truncated') + usage(50, 7) + '\n');
  expect(
    (await scanCached(codexParser, path, cache)).records.map(
      (record) => record.inputTokens,
    ),
  ).toEqual([7]);
  await rename(path, join(dir, 'old.jsonl'));
  await writeFile(path, prefix('rotated') + usage(60, 8) + '\n');
  expect(
    (await scanCached(codexParser, path, cache)).records.map(
      (record) => record.inputTokens,
    ),
  ).toEqual([8]);
});
