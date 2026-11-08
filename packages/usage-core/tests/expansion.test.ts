import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decompress } from 'fzstd';
import sqlite3 from 'sqlite3';
import { describe, expect, it } from 'vitest';
import { codexParser } from '../src/parsers/codex.js';
import { grokBuildParser } from '../src/parsers/grok-build.js';
import { scanCached } from '../src/service/cache.js';
import {
  ExpansionLimitError,
  lines,
  ZstdFrameGuard,
  ZstdIntegrityError,
} from '../src/parsers/shared.js';
import { testTempDir } from './test-temp.js';

const fixture = resolve(
  'packages/usage-core/fixtures/synthetic/codex.jsonl.zst',
);

// Synthetic frames generated with zstd --check; their checksum bytes are
// independent of the implementation under test and require no zstd binary.
const checkedCodex = Buffer.from('KLUv/WR5APUFANKKIR1gR+MGEWq1t7CXpfsenPw9IQyCr2bU3w3IEPhYPMR77yF1KNNlzMJLoVYSGGg0I/LyCO325aB0bpcoywPZKQR7eweUqcuCPbip1jTIcoF0TgA6Bh0DUJzi6UnD5mwsHcm1rQ+ydQ2lBdfEe0emOdss9kP6wkUMmLwcO5vSZczJT8/E0D8EFQA/XVLo3QrLhiuH2+QIjMYZ9M8U2AfhI7AfYfogwMTk+cIb6cRwleZVCyuYATJppX1Fpp5MVcgJ', 'base64');
const checkedGrok = Buffer.from('KLUv/STARQQAIskcG4C3OsZFgeRpIh9Db0OoDVmGdH20Mr/AwsoGDICmSWTbcjwU/hjLrdU9hRXTZB3rJ1F6XC1wq34Kw/eD0hdl29RjdmfSl14/12WmdK1CJWwrFhq6cE4TJCo/H6RMAUoCJREw0nh67J+v1pr0HuLTWYtnAgYAOEuaqo5nAEvPNlHZvq17ArcGk2s=', 'base64');
const checkedEmpty = Buffer.from('KLUv/SQAAQAAmenYUQ==', 'base64');

function rawFrame(content: Buffer): Buffer {
  // A synthetic zstd frame with a 1 KiB window and one uncompressed block.
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0, 0]);
  header.writeUIntLE((content.length << 3) | 1, 6, 3);
  return Buffer.concat([header, content]);
}

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

  it('enforces file and scan allowances on checksummed frames', async () => {
    const dir = await testTempDir('zstd-checked-limit-');
    const path = join(dir, 'checked.jsonl.zst');
    await writeFile(path, checkedCodex);
    const consume = async (budget: { remaining: number; perFile: number }) => {
      for await (const line of lines(path, budget)) void line;
    };
    await expect(consume({ remaining: 100_000, perFile: 1 })).rejects.toBeInstanceOf(ExpansionLimitError);
    const budget = { remaining: 100_000, perFile: 100_000 };
    await consume(budget);
    budget.remaining = 1;
    await expect(consume(budget)).rejects.toBeInstanceOf(ExpansionLimitError);
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

  it('validates checksums independently for concatenated and skippable frames', async () => {
    const dir = await testTempDir('zstd-checksum-');
    const path = join(dir, 'checked.jsonl.zst');
    const corrupt = Buffer.from(checkedCodex);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 7, 8, 9]);
    await writeFile(path, Buffer.concat([checkedCodex, skip, checkedCodex]));
    expect((await codexParser.parse(path)).records).toHaveLength(1);
    // Split checksum across createReadStream's default 64 KiB chunk boundary.
    const padding = 65535 - (checkedCodex.length - 4) - 8;
    const skipHeader = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
    skipHeader.writeUInt32LE(padding, 4);
    await writeFile(path, Buffer.concat([skipHeader, Buffer.alloc(padding), checkedCodex]));
    expect((await codexParser.parse(path)).records).toHaveLength(1);
    await writeFile(path, Buffer.concat([checkedCodex, skip, corrupt]));
    const result = await codexParser.parse(path);
    expect(result.partial).toBe(true);
    expect(result.warnings).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.limits).toEqual([]);
    const readBroken = async () => { for await (const line of lines(path)) void line; };
    await expect(readBroken()).rejects.toBeInstanceOf(ZstdIntegrityError);
    const cached = await scanCached(codexParser, path, join(dir, 'cache.sqlite'));
    expect(cached.partial).toBe(true);
    expect(cached.records).toEqual([]);
  });

  it('checks an empty frame before proceeding past empty skippable frames', async () => {
    const dir = await testTempDir('zstd-empty-');
    const path = join(dir, 'empty.jsonl.zst');
    const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
    await writeFile(path, Buffer.concat([skip, checkedEmpty, skip, checkedCodex]));
    const valid = await codexParser.parse(path);
    expect(valid.records).toHaveLength(1);
    expect(valid.partial).not.toBe(true);
    const corrupt = Buffer.from(checkedEmpty);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await writeFile(path, Buffer.concat([checkedCodex, skip, corrupt]));
    const invalid = await codexParser.parse(path);
    expect(invalid.partial).toBe(true);
    expect(invalid.records).toEqual([]);
    expect(invalid.warnings).toBe(1);
  });

  it('reads archive records without a final newline and invalidates previous cache versions', async () => {
    for (const [parser, frame, oldVersion] of [
      [codexParser, checkedCodex, 11], [grokBuildParser, checkedGrok, 14],
    ] as const) {
      const dir = await testTempDir('zstd-cache-version-');
      const path = join(dir, 'usage.jsonl.zst');
      const cache = join(dir, 'cache.sqlite');
      const text = Buffer.from(decompress(frame));
      expect(text.at(-1)).toBe(10);
      await writeFile(path, rawFrame(text.subarray(0, -1)));
      expect((await parser.parse(path)).records).toHaveLength(1);
      const actual = await scanCached(parser, path, cache);
      expect(actual.records).toHaveLength(1);
      expect(actual.warnings).toBe(0);
      const db = new sqlite3.Database(cache);
      try {
        const row = await new Promise<{ signature: string }>((resolve, reject) => db.get(
          'SELECT signature FROM scan_cache', (error, value) => error ? reject(error) : resolve(value as { signature: string }),
        ));
        const signature = JSON.parse(row.signature) as unknown[];
        signature[0] = oldVersion;
        await new Promise<void>((resolve, reject) => db.run(
          'UPDATE scan_cache SET signature = ?, result = ?',
          [JSON.stringify(signature), JSON.stringify({ ...actual, records: [] })],
          (error) => error ? reject(error) : resolve(),
        ));
      } finally {
        await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
      }
      expect((await scanCached(parser, path, cache)).records).toHaveLength(1);
      if (parser === codexParser) {
        const folder = join(dir, 'sessions');
        await mkdir(folder);
        await writeFile(join(folder, 'usage.jsonl.zst'), rawFrame(text.subarray(0, -1)));
        expect((await scanCached(parser, folder, cache)).records).toHaveLength(1);
      }
      await writeFile(path, rawFrame(Buffer.concat([text, Buffer.from('{broken')])));
      const damaged = await scanCached(parser, path, cache);
      expect(damaged.records).toHaveLength(1);
      expect(damaged).toMatchObject({ warnings: 1, partial: true });
    }
  });

  it('rejects a fabricated checksum on a later frame without retaining records', async () => {
    const dir = await testTempDir('zstd-fake-checksum-');
    const path = join(dir, 'checksum.jsonl.zst');
    const frame = await readFile(fixture);
    const invalid = Buffer.from(frame);
    invalid[4] = invalid[4]! | 4;
    await writeFile(path, Buffer.concat([frame, invalid, Buffer.alloc(4)]));
    const result = await codexParser.parse(path);
    expect(result.partial).toBe(true);
    expect(result.warnings).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.limits).toEqual([]);
  });

  it('discards Grok records when a later frame has a bad checksum', async () => {
    const dir = await testTempDir('zstd-grok-checksum-');
    const path = join(dir, 'grok.jsonl.zst');
    const corrupt = Buffer.from(checkedGrok);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await writeFile(path, checkedGrok);
    expect((await grokBuildParser.parse(path)).records).toHaveLength(1);
    await writeFile(path, Buffer.concat([checkedGrok, corrupt]));
    const result = await grokBuildParser.parse(path);
    expect(result.partial).toBe(true);
    expect(result.warnings).toBe(1);
    expect(result.records).toEqual([]);
    expect(result.warningDetails).toEqual(['Zstd checksum nesúhlasí; súbor bol vynechaný.']);
    await writeFile(path, Buffer.concat([checkedGrok, checkedGrok.subarray(0, 6)]));
    const truncated = await grokBuildParser.parse(path);
    expect(truncated.partial).toBe(true);
    expect(truncated.records).toEqual([]);
    expect(truncated.warnings).toBe(1);
    await expect(grokBuildParser.parse('credentials/secret.zst')).rejects.toThrow('Nepovolená cesta');
  });

  it('keeps other complete files but discards every record from a corrupt file', async () => {
    const dir = await testTempDir('zstd-mixed-');
    const folder = join(dir, 'sessions');
    await mkdir(folder);
    const corrupt = Buffer.from(checkedCodex);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await writeFile(join(folder, 'valid.jsonl.zst'), checkedCodex);
    await writeFile(join(folder, 'bad.jsonl.zst'), Buffer.concat([checkedCodex, corrupt]));
    const result = await codexParser.parse(folder);
    expect(result.partial).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.warnings).toBe(1);
    expect(result.warningDetails).toContain('Zstd checksum nesúhlasí; súbor bol vynechaný.');
    const cached = await scanCached(codexParser, folder, join(dir, 'cache.sqlite'));
    expect(cached.partial).toBe(true);
    expect(cached.records).toHaveLength(1);
    expect(cached.warningDetails).toContain('Zstd checksum nesúhlasí; súbor bol vynechaný.');
  });

  it('reports a checksum error through the packaged sidecar', async () => {
    const dir = await testTempDir('zstd-sidecar-');
    const path = join(dir, 'broken.jsonl.zst');
    const corrupt = Buffer.from(checkedCodex);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await writeFile(path, Buffer.concat([checkedCodex, corrupt]));
    const request = { version: 1, requestId: 'checksum', method: 'scan', params: { agent: 'codex', path, cachePath: join(dir, 'cache.sqlite') } };
    const run = spawnSync(process.execPath, [resolve('apps/desktop/usage-service/main.cjs')], {
      input: `${JSON.stringify(request)}\n`, encoding: 'utf8',
      env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) },
    });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout).result;
    expect(result.status).toBe('partial');
    expect(result.records).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
