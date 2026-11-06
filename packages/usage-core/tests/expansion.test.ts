import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexParser } from '../src/parsers/codex.js';
import {
  ExpansionLimitError,
  lines,
  ZstdFrameGuard,
} from '../src/parsers/shared.js';
import { testTempDir } from './test-temp.js';

const fixture = resolve(
  'packages/usage-core/fixtures/synthetic/codex.jsonl.zst',
);

async function read(budget: { remaining: number; perFile: number }) {
  const result: string[] = [];
  for await (const line of lines(fixture, budget)) result.push(line);
  return result;
}

describe('compressed usage expansion limits', () => {
  it('rejects a huge zstd window before the decoder can allocate it', () => {
    const guard = new ZstdFrameGuard(256 * 1024 * 1024);
    const header = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x97]);
    expect(() => guard.push(header, () => {})).toThrow(ExpansionLimitError);
  });

  it('validates concatenated frames and skippable frames across chunk boundaries', async () => {
    const frame = await readFile(fixture);
    const skipped = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 7, 8, 9]);
    const input = Buffer.concat([frame, skipped, frame]);
    const guard = new ZstdFrameGuard(256 * 1024 * 1024);
    const accepted: Buffer[] = [];
    for (const byte of input)
      guard.push(Uint8Array.of(byte), (part) =>
        accepted.push(Buffer.from(part)),
      );
    guard.finish();
    expect(Buffer.concat(accepted)).toEqual(input);
    const dir = await testTempDir('zstd-frames-');
    const path = join(dir, 'frames.jsonl.zst');
    await writeFile(path, input);
    const actual: string[] = [];
    for await (const line of lines(path)) actual.push(line);
    expect(actual).toEqual([
      ...(await read({ remaining: 100_000, perFile: 100_000 })),
      ...(await read({ remaining: 100_000, perFile: 100_000 })),
    ]);
  });
  it('rejects a fixture larger than its per-file expansion allowance', async () => {
    await expect(
      read({ remaining: 100_000, perFile: 1 }),
    ).rejects.toBeInstanceOf(ExpansionLimitError);
  });

  it('charges a shared scan allowance across compressed files', async () => {
    const budget = { remaining: 100_000, perFile: 100_000 };
    expect((await read(budget)).length).toBeGreaterThan(0);
    const used = 100_000 - budget.remaining;
    budget.remaining = used - 1;
    await expect(read(budget)).rejects.toBeInstanceOf(ExpansionLimitError);
    expect(budget.remaining).toBe(0);
  });

  it('discards a Codex file when a later compressed frame is truncated', async () => {
    const dir = await testTempDir('zstd-truncated-');
    const path = join(dir, 'truncated.jsonl.zst');
    const frame = await readFile(fixture);
    await writeFile(path, Buffer.concat([frame, frame.subarray(0, 6)]));
    const result = await codexParser.parse(path);
    expect(result.partial).toBe(true);
    expect(result.warnings).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.limits).toEqual([]);
  });
});
