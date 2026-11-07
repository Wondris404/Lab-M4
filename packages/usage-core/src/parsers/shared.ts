import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, parse, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { Decompress } from 'fzstd';
import xxhash, { type XXHash } from 'xxhash-wasm';

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
export const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
export const time = (v: unknown): string | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};
const forbidden = /auth|credential|token|secret|key|login|\.env/i;
export class LineLimitError extends Error {
  constructor() {
    super('Usage log line exceeds 1 MiB');
  }
}
export class ExpansionLimitError extends Error {
  constructor() {
    super('Compressed usage log exceeds the decompression limit');
  }
}
export class ZstdIntegrityError extends Error {
  constructor() {
    super('Compressed usage log checksum does not match');
  }
}

/** Shared by all compressed files in a scan; bytes are charged even on failure. */
export interface ExpansionBudget {
  remaining: number;
  perFile: number;
}
export const newExpansionBudget = (): ExpansionBudget => ({
  remaining: 1024 * 1024 * 1024,
  perFile: 256 * 1024 * 1024,
});

/** Check every frame before fzstd allocates its declared history window. */
export class ZstdFrameGuard {
  private stage: 'frame' | 'block' | 'payload' | 'checksum' | 'skip' = 'frame';
  private header: number[] = [];
  private pending = 0;
  private last = false;
  private checksum = false;
  private checksumBytes: number[] = [];
  constructor(
    private readonly maxWindow: number,
    private readonly onStart: (checksum: boolean) => void = () => {},
    private readonly onEnd: (checksum?: number) => void = () => {},
  ) {}

  private finishFrame(): void {
    const checksum = this.checksum
      ? (this.checksumBytes[0]! | (this.checksumBytes[1]! << 8) |
          (this.checksumBytes[2]! << 16) | (this.checksumBytes[3]! << 24)) >>> 0
      : undefined;
    this.onEnd(checksum);
    this.checksumBytes = [];
    this.stage = 'frame';
  }

  push(chunk: Uint8Array, emit: (data: Uint8Array, skippable: boolean) => void): void {
    let pos = 0;
    while (pos < chunk.length) {
      if (
        this.stage === 'payload' ||
        this.stage === 'checksum' ||
        this.stage === 'skip'
      ) {
        const amount = Math.min(this.pending, chunk.length - pos);
        if (amount) {
          const data = chunk.subarray(pos, pos + amount);
          if (this.stage === 'checksum') this.checksumBytes.push(...data);
          emit(data, this.stage === 'skip');
        }
        pos += amount;
        this.pending -= amount;
        if (!this.pending) {
          if (this.stage === 'checksum') this.finishFrame();
          else if (this.stage === 'skip') this.stage = 'frame';
          else if (!this.last) this.stage = 'block';
          else if (this.checksum) {
            this.stage = 'checksum';
            this.pending = 4;
          } else this.finishFrame();
        }
        continue;
      }
      this.header.push(chunk[pos++]!);
      if (this.stage === 'block') {
        if (this.header.length < 3) continue;
        const block =
          this.header[0]! | (this.header[1]! << 8) | (this.header[2]! << 16);
        const type = (block >> 1) & 3;
        if (type === 3) throw new Error('Invalid zstd block');
        this.last = (block & 1) !== 0;
        this.pending = type === 1 ? 1 : block >>> 3;
        emit(Uint8Array.from(this.header), false);
        this.header = [];
        this.stage = 'payload';
        if (!this.pending) {
          if (!this.last) this.stage = 'block';
          else if (this.checksum) {
            this.stage = 'checksum';
            this.pending = 4;
          } else this.finishFrame();
        }
        continue;
      }
      if (this.header.length < 5) continue;
      if (
        (this.header[0]! & 0xf0) === 0x50 &&
        this.header[1] === 0x2a &&
        this.header[2] === 0x4d &&
        this.header[3] === 0x18
      ) {
        if (this.header.length < 8) continue;
        this.pending =
          (this.header[4]! |
            (this.header[5]! << 8) |
            (this.header[6]! << 16) |
            (this.header[7]! << 24)) >>>
          0;
        emit(Uint8Array.from(this.header), true);
        this.header = [];
        this.stage = this.pending ? 'skip' : 'frame';
        continue;
      }
      if (
        this.header[0] !== 0x28 ||
        this.header[1] !== 0xb5 ||
        this.header[2] !== 0x2f ||
        this.header[3] !== 0xfd
      )
        throw new Error('Unsupported zstd frame');
      const flags = this.header[4]!;
      if (flags & 8) throw new Error('Invalid zstd frame');
      const single = (flags & 32) !== 0;
      const dictionaryBytes = [0, 1, 2, 4][flags & 3]!;
      const sizeFlag = flags >>> 6;
      const sizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag;
      const sizeOffset = 5 + (single ? 0 : 1) + dictionaryBytes;
      if (this.header.length < sizeOffset + sizeBytes) continue;
      let window = 0n;
      if (single) {
        for (let i = 0; i < sizeBytes; i++)
          window |= BigInt(this.header[sizeOffset + i]!) << BigInt(8 * i);
        if (sizeFlag === 1) window += 256n;
      } else {
        const descriptor = this.header[5]!;
        const base = 1n << BigInt(10 + (descriptor >>> 3));
        window = base + (base >> 3n) * BigInt(descriptor & 7);
      }
      if (window > BigInt(this.maxWindow)) throw new ExpansionLimitError();
      this.checksum = (flags & 4) !== 0;
      this.onStart(this.checksum);
      emit(Uint8Array.from(this.header), false);
      this.header = [];
      this.stage = 'block';
    }
  }

  finish(): void {
    if (this.stage !== 'frame' || this.header.length)
      throw new Error('Incomplete zstd frame');
  }
}
export async function assertSafeFile(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let parent = root;
  for (const part of parts) {
    if (forbidden.test(part)) throw new Error('Nepovolená cesta.');
    parent = join(parent, part);
    if ((await lstat(parent)).isSymbolicLink())
      throw new Error('Nepovolený odkaz.');
  }
  if (forbidden.test(basename(path)))
    throw new Error('Nepovolený názov súboru.');
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    forbidden.test(basename(await realpath(path)))
  )
    throw new Error('Nepovolený zdroj.');
}
export async function* lines(
  path: string,
  budget = newExpansionBudget(),
): AsyncGenerator<string> {
  await assertSafeFile(path);
  let expanded = 0;
  const compressed = /\.zst$/i.test(path);
  if (compressed && budget.remaining <= 0) throw new ExpansionLimitError();
  const hashes = compressed ? await xxhash() : undefined;
  const stream = createReadStream(path);
  const decompressed = compressed
    ? stream.pipe(
        new Transform({
          construct(callback) {
            const state = this as Transform & {
              decoder?: Decompress;
              guard?: ZstdFrameGuard;
            };
            let hash: XXHash<bigint> | undefined;
            state.guard = new ZstdFrameGuard(
              budget.perFile,
              (hasChecksum) => {
                hash = hasChecksum ? hashes!.create64() : undefined;
                state.decoder = new Decompress((data) => {
                  expanded += data.byteLength;
                  const exceedsScan = data.byteLength > budget.remaining;
                  budget.remaining = Math.max(0, budget.remaining - data.byteLength);
                  if (expanded > budget.perFile || exceedsScan) throw new ExpansionLimitError();
                  hash?.update(data);
                  state.push(Buffer.from(data));
                });
              },
              (expected) => {
                state.decoder!.push(new Uint8Array(), true);
                if (expected !== undefined && Number(hash!.digest() & 0xffffffffn) !== expected)
                  throw new ZstdIntegrityError();
              },
            );
            callback();
          },
          transform(chunk: Buffer, _encoding, callback) {
            try {
              const state = this as Transform & {
                decoder: Decompress;
                guard: ZstdFrameGuard;
              };
              state.guard.push(chunk, (data, skippable) =>
                { if (!skippable) state.decoder.push(data, false); },
              );
              callback();
            } catch (e) {
              callback(e as Error);
            }
          },
          flush(callback) {
            try {
              const state = this as Transform & {
                decoder: Decompress;
                guard: ZstdFrameGuard;
              };
              state.guard.finish();
              callback();
            } catch (e) {
              callback(e as Error);
            }
          },
        }),
      )
    : stream;
  if (decompressed !== stream)
    stream.on('error', (error) => decompressed.destroy(error));
  let lineBytes = 0;
  let endsWithNewline = false;
  const bounded = decompressed.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (chunk.length) endsWithNewline = chunk[chunk.length - 1] === 10;
        for (const byte of chunk) {
          lineBytes = byte === 10 ? 0 : lineBytes + 1;
          if (lineBytes > 1024 * 1024) return callback(new LineLimitError());
        }
        callback(null, chunk);
      },
    }),
  );
  decompressed.on('error', (error: Error) => bounded.destroy(error));
  try {
    let pending: string | undefined;
    for await (const line of createInterface({
      input: bounded,
      crlfDelay: Infinity,
    })) {
      if (pending !== undefined) yield pending;
      pending = line;
    }
    // A validated archive has a definite EOF; a live plain log still needs LF.
    if (pending !== undefined && (compressed || endsWithNewline)) yield pending;
  } finally {
    stream.destroy();
    decompressed.destroy();
    bounded.destroy();
  }
}
export async function* findCodexFiles(path: string): AsyncGenerator<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new Error('Symbolické odkazy nie sú povolené.');
  if (info.isFile()) {
    if (/\.jsonl(?:\.zst)?$/i.test(path)) {
      await assertSafeFile(path);
      yield path;
    }
    return;
  }
  if (basename(path).toLowerCase() === '.codex') {
    for (const name of ['sessions', 'archived_sessions']) {
      try {
        yield* findCodexFiles(join(path, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || forbidden.test(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* findCodexFiles(child);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name))
      yield child;
  }
}
