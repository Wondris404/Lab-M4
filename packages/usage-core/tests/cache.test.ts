import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { scanCached } from '../src/service/cache.js';
import { emptyResult, type Parser } from '../src/parsers/contracts.js';

it('reuses unchanged sources and rescans a changed source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-cache-'));
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
