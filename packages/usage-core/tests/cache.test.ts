import { readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testTempDir } from './test-temp.js';
import { expect, it, vi } from 'vitest';
import { scanCached } from '../src/service/cache.js';
import { emptyResult, type Parser } from '../src/parsers/contracts.js';

it('reuses unchanged sources and rescans a changed source', async () => {
  const dir = await testTempDir('usage-cache-');
  try {
    const source = join(dir, 'source.jsonl');
    const cache = join(dir, 'cache.sqlite');
    await writeFile(source, 'one\n');
    const parse = vi.fn(async () => emptyResult());
    const parser: Parser = { provider: 'grok-build', parse };
    await scanCached(parser, source, cache);
    await scanCached(parser, source, cache);
    expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(source, 'one\ntwo\n');
    await scanCached(parser, source, cache);
    expect(parse).toHaveBeenCalledTimes(2);
    const stableTime = new Date('2025-01-01T00:00:00.000Z');
    await utimes(source, stableTime, stableTime);
    await scanCached(parser, source, cache, true);
    expect(parse).toHaveBeenCalledTimes(3);
    const original = await stat(source);
    const replacement = join(dir, 'replacement.jsonl');
    await writeFile(replacement, 'two\none\n');
    await utimes(replacement, original.atime, original.mtime);
    await rename(replacement, source);
    await scanCached(parser, source, cache);
    expect(parse).toHaveBeenCalledTimes(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('invalidates a Codex directory when a synthetic session changes', async () => {
  const dir = await testTempDir('usage-folder-');
  try {
    const source = join(dir, 'sessions');
    const cache = join(dir, 'cache.sqlite');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(source);
    await writeFile(join(source, 'session.jsonl'), 'one\n');
    const parse = vi.fn(async () => emptyResult());
    const parser: Parser = { provider: 'codex', parse };
    await scanCached(parser, source, cache);
    await scanCached(parser, source, cache);
    expect(parse).toHaveBeenCalledTimes(1);
    await writeFile(join(source, 'session.jsonl'), 'one\ntwo\n');
    await scanCached(parser, source, cache);
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('stores stable pseudonyms instead of synthetic session identifiers', async () => {
  const dir = await testTempDir('usage-private-');
  try {
    const source = join(dir, 'source.jsonl');
    const cache = join(dir, 'cache.sqlite');
    await writeFile(source, 'synthetic\n');
    const parse = vi.fn(async () => ({ ...emptyResult(), records: [{ provider: 'codex' as const, sessionId: 'synthetic-session-id', model: 'unknown', timestamp: '2025-01-01T00:00:00.000Z', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, speed: 'unknown' as const, costSource: 'neznáme' as const }] }));
    const parser: Parser = { provider: 'codex', parse };
    const first = await scanCached(parser, source, cache);
    const second = await scanCached(parser, source, cache, true);
    expect(first.records[0]?.sessionId).toEqual(second.records[0]?.sessionId);
    expect(first.records[0]?.sessionId).not.toEqual('synthetic-session-id');
    expect((await readFile(cache)).includes(Buffer.from('synthetic-session-id'))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
