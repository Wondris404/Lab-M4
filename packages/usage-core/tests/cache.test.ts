import { rm, writeFile } from 'node:fs/promises';
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
    await scanCached(parser, source, cache, true);
    expect(parse).toHaveBeenCalledTimes(3);
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
