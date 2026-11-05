import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, parse, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { createInterface } from 'node:readline';
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
  const stream = createReadStream(path);
  const decompressed = compressed
    ? stream.pipe(
        new Transform({
          construct(callback) {
            const state = this as Transform & { decoder?: Decompress };
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
              (this as Transform & { decoder: Decompress }).decoder.push(
                chunk,
                false,
              );
              callback();
            } catch (e) {
              callback(e as Error);
            }
          },
          flush(callback) {
            try {
              (this as Transform & { decoder: Decompress }).decoder.push(
                new Uint8Array(),
                true,
              );
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
  const bounded = decompressed.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
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
    for await (const line of createInterface({
      input: bounded,
      crlfDelay: Infinity,
    }))
      yield line;
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
