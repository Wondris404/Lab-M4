import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, parse, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { Decompress } from 'fzstd';

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
  constructor(private readonly maxWindow: number) {}

  push(chunk: Uint8Array, emit: (data: Uint8Array) => void): void {
    let pos = 0;
    while (pos < chunk.length) {
      if (
        this.stage === 'payload' ||
        this.stage === 'checksum' ||
        this.stage === 'skip'
      ) {
        const amount = Math.min(this.pending, chunk.length - pos);
        if (amount) emit(chunk.subarray(pos, pos + amount));
        pos += amount;
        this.pending -= amount;
        if (!this.pending) {
          if (this.stage === 'checksum' || this.stage === 'skip')
            this.stage = 'frame';
          else if (!this.last) this.stage = 'block';
          else if (this.checksum) {
            this.stage = 'checksum';
            this.pending = 4;
          } else this.stage = 'frame';
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
        emit(Uint8Array.from(this.header));
        this.header = [];
        this.stage = 'payload';
        if (!this.pending) {
          if (!this.last) this.stage = 'block';
          else if (this.checksum) {
            this.stage = 'checksum';
            this.pending = 4;
          } else this.stage = 'frame';
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
        emit(Uint8Array.from(this.header));
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
      emit(Uint8Array.from(this.header));
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
  onLongLine?: () => void,
): AsyncGenerator<string> {
  await assertSafeFile(path);
  let expanded = 0;
  const compressed = /\.zst$/i.test(path);
  if (compressed && budget.remaining <= 0) throw new ExpansionLimitError();
  const stream = createReadStream(path);
  const decompressed = compressed
    ? stream.pipe(
        new Transform({
          construct(callback) {
            const state = this as Transform & {
              decoder?: Decompress;
              guard?: ZstdFrameGuard;
            };
            state.guard = new ZstdFrameGuard(budget.perFile);
            state.decoder = new Decompress((data) => {
              expanded += data.byteLength;
              const exceedsScan = data.byteLength > budget.remaining;
              budget.remaining = Math.max(
                0,
                budget.remaining - data.byteLength,
              );
              if (expanded > budget.perFile || exceedsScan) {
                throw new ExpansionLimitError();
              }
              state.push(Buffer.from(data));
            });
            callback();
          },
          transform(chunk: Buffer, _encoding, callback) {
            try {
              const state = this as Transform & {
                decoder: Decompress;
                guard: ZstdFrameGuard;
              };
              state.guard.push(chunk, (data) =>
                state.decoder.push(data, false),
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
              state.decoder.push(new Uint8Array(), true);
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
  const limit = 1024 * 1024;
  let pieces: Buffer[] = [];
  let length = 0;
  let discarding = false;
  try {
    for await (const chunk of decompressed as AsyncIterable<Buffer>) {
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (!discarding && length + end - start > limit) {
          if (!onLongLine) throw new LineLimitError();
          onLongLine();
          pieces = [];
          length = 0;
          discarding = true;
        }
        if (!discarding && end > start) {
          pieces.push(chunk.subarray(start, end));
          length += end - start;
        }
        if (newline >= 0) {
          if (!discarding) yield Buffer.concat(pieces, length).toString('utf8').replace(/\r$/, '');
          pieces = [];
          length = 0;
          discarding = false;
        }
        start = end + 1;
      }
    }
  } finally {
    stream.destroy();
    decompressed.destroy();
  }
}
export async function* findCodexFiles(
  path: string,
  historyOnly = false,
  onError?: () => void,
): AsyncGenerator<string> {
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
  if (historyOnly || basename(path).toLowerCase() === '.codex') {
    for (const name of ['sessions', 'archived_sessions']) {
      try {
        const child = join(path, name);
        if (!(await lstat(child)).isDirectory()) continue;
        yield* findCodexFiles(child, false, onError);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (!onError) throw error;
        onError();
      }
    }
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || forbidden.test(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      try {
        yield* findCodexFiles(child, false, onError);
      } catch (error) {
        if (!onError) throw error;
        onError();
      }
    } else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name))
      yield child;
  }
}
