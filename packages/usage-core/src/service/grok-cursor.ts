import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import sqlite3 from 'sqlite3';
import { emptyResult, type ParseResult } from '../parsers/contracts.js';
import {
  grokAccumulator,
  type GrokCursorState,
} from '../parsers/grok-build.js';
import { assertSafeFile, LineLimitError } from '../parsers/shared.js';
import { normalizeRecord } from './normalize.js';

interface CursorRow {
  dev: number;
  ino: number;
  size: number;
  mtime: number;
  ctime: number;
  offset: number;
  tail: string;
  state: string;
  result: string;
}

async function tailHash(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(offset, 4096);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset - length);
  if (bytesRead !== length) throw new Error('Source changed while scanning');
  return createHash('sha256').update(buffer).digest('hex');
}

/** Persist only normalized records, pseudonymous parser state and file metadata. */
export async function scanGrokAppend(
  db: sqlite3.Database,
  key: string,
  path: string,
  pseudonym: (id: string) => string,
  force: boolean,
): Promise<ParseResult> {
  const run = (sql: string, values: unknown[] = []) =>
    new Promise<void>((resolve, reject) =>
      db.run(sql, values, (error) => (error ? reject(error) : resolve())),
    );
  await run(
    'CREATE TABLE IF NOT EXISTS grok_cursor (id TEXT PRIMARY KEY, dev INTEGER, ino INTEGER, size INTEGER, mtime REAL, ctime REAL, offset INTEGER, tail TEXT, state TEXT, result TEXT)',
  );
  const row = await new Promise<CursorRow | undefined>((resolve, reject) =>
    db.get(
      'SELECT dev, ino, size, mtime, ctime, offset, tail, state, result FROM grok_cursor WHERE id = ?',
      [key],
      (error, value) =>
        error ? reject(error) : resolve(value as CursorRow | undefined),
    ),
  );

  await assertSafeFile(path);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const sameFile = row && row.dev === info.dev && row.ino === info.ino;
    if (
      !force &&
      sameFile &&
      row.size === info.size &&
      row.mtime === info.mtimeMs &&
      row.ctime === info.ctimeMs
    )
      return JSON.parse(row.result) as ParseResult;
    const append =
      !force &&
      sameFile &&
      info.size > row.size &&
      row.offset <= row.size &&
      (await tailHash(file, row.offset)) === row.tail;
    const oldResult = append
      ? (JSON.parse(row.result) as ParseResult)
      : emptyResult();
    const previous = append
      ? (JSON.parse(row.state) as GrokCursorState)
      : undefined;
    const accumulator = grokAccumulator(previous, pseudonym);
    let offset = append ? row.offset : 0;
    let position = offset;
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    try {
      while (position < info.size) {
        const { bytesRead } = await file.read(
          chunk,
          0,
          Math.min(chunk.length, info.size - position),
          position,
        );
        if (!bytesRead) throw new Error('Source changed while scanning');
        const base = position - carry.length;
        position += bytesRead;
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (
          let end = data.indexOf(10, start);
          end !== -1;
          end = data.indexOf(10, start)
        ) {
          if (end - start > 1024 * 1024) throw new LineLimitError();
          let line = data.subarray(start, end).toString('utf8');
          if (line.endsWith('\r')) line = line.slice(0, -1);
          accumulator.consume(line);
          start = end + 1;
          offset = base + start;
        }
        carry = data.subarray(start);
        if (carry.length > 1024 * 1024) throw new LineLimitError();
      }
    } catch (error) {
      if (error instanceof LineLimitError)
        return { ...emptyResult(), warnings: 1, partial: true };
      throw error;
    }
    const endInfo = await file.stat();
    const pathInfo = await lstat(path);
    if (
      pathInfo.isSymbolicLink() ||
      endInfo.dev !== pathInfo.dev ||
      endInfo.ino !== pathInfo.ino ||
      endInfo.size !== info.size ||
      endInfo.mtimeMs !== info.mtimeMs ||
      endInfo.ctimeMs !== info.ctimeMs
    )
      return { ...emptyResult(), warnings: 1, partial: true };
    const fresh = accumulator.result;
    const result: ParseResult = {
      ...oldResult,
      records: [...oldResult.records, ...fresh.records.map(normalizeRecord)],
      warnings: oldResult.warnings + fresh.warnings,
    };
    const tail = await tailHash(file, offset);
    await run(
      'INSERT OR REPLACE INTO grok_cursor (id, dev, ino, size, mtime, ctime, offset, tail, state, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        key,
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        offset,
        tail,
        JSON.stringify(accumulator.state()),
        JSON.stringify(result),
      ],
    );
    return result;
  } finally {
    await file.close();
  }
}
