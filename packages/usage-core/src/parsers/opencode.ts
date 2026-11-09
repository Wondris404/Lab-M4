import sqlite3 from 'sqlite3';
import { createWriteStream, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { emptyResult, type Parser, type ParseResult } from './contracts.js';
import { assertSafeFile, count, str, time } from './shared.js';

type Row = Record<string, unknown>;
function mismatch(r: ParseResult, key: string): void {
  r.mismatchFields[key] = (r.mismatchFields[key] ?? 0) + 1;
}
export function consumeOpenCodeRow(row: Row, result: ParseResult): void {
  const sessionId = str(row.sessionId),
    timestamp = time(row.timestamp);
  const input = count(row.input),
    cache = count(row.cache),
    write = count(row.cacheWrite),
    output = count(row.output),
    reasoning = count(row.reasoning);
  if (
    !sessionId ||
    !timestamp ||
    input === undefined ||
    cache === undefined ||
    write === undefined ||
    output === undefined ||
    reasoning === undefined
  ) {
    result.warnings++;
    mismatch(result, 'missing_fields');
    return;
  }
  const expected = input + cache + write + output + reasoning;
  const warnings: string[] = [];
  if (
    row.total !== null &&
    row.total !== undefined &&
    (typeof row.total !== 'number' || row.total !== expected)
  ) {
    result.warnings++;
    warnings.push('TOTAL_MISMATCH');
    mismatch(result, 'total');
    if (typeof row.total === 'number')
      mismatch(
        result,
        row.total < expected
          ? 'total_less_than_components'
          : 'total_greater_than_components',
      );
    else mismatch(result, 'total_not_numeric');
  }
  // NEOVERENÉ: the source cost currency is not established.
  result.records.push({
    provider: 'opencode',
    sessionId,
    model: str(row.model) ?? 'unknown',
    timestamp,
    inputTokens: input + cache + write,
    cachedInputTokens: cache,
    outputTokens: output + reasoning,
    reasoningTokens: reasoning,
    speed: 'unknown',
    costSource: 'neznáme',
    ...(warnings.length > 0 && { warnings }),
  });
}
function identity(stat: BigIntStats) {
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Invalid SQLite source');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function openCodeSnapshot(path: string) {
  await assertSafeFile(path);
  const fingerprint = async (file: string) => {
    try {
      return identity(await lstat(file, { bigint: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const [database, wal, journal] = await Promise.all(
    ['', '-wal', '-journal'].map((suffix) => fingerprint(path + suffix)),
  );
  return {
    signature: JSON.stringify([database, wal, journal]),
    database,
    wal,
    journal,
  };
}

async function copySnapshotFile(source: string, destination: string, expected: string) {
  const file = await open(source, 'r');
  try {
    if (identity(await file.stat({ bigint: true })) !== expected)
      throw new Error('OpenCode source changed before copy');
    await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(destination, { flags: 'wx' }));
  } finally {
    await file.close();
  }
}

async function readDatabase(path: string, immutable = true): Promise<ParseResult> {
  const result = emptyResult();
  // Immutable mode avoids source locks, recovery and writes to WAL/SHM.
  // The caller verifies the database and writer side files around this read.
  const uri = pathToFileURL(path).href + (immutable ? '?mode=ro&immutable=1' : '?mode=ro');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const d = new sqlite3.Database(
      uri,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
      (err) => (err ? reject(err) : resolve(d)),
    );
  });
  db.configure('busyTimeout', 200);
  const query = (sql: string) =>
    new Promise<void>((resolve, reject) => {
      db.each(
        sql,
        (err, row) => {
          if (err) {
            result.warnings++;
            return;
          }
          consumeOpenCodeRow(row as Row, result);
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) => {
      db.exec(sql, (error) => (error ? reject(error) : resolve()));
    });
  const all = (sql: string) =>
    new Promise<Row[]>((resolve, reject) =>
      db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows as Row[]))),
    );
  try {
    await exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN');
    const tables = await all(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('message','session')",
    );
    if (!tables.some(({ name }) => name === 'message'))
      throw new Error('Unsupported OpenCode schema');
    await query(`SELECT session_id AS sessionId, time_created AS timestamp, json_extract(data,'$.modelID') AS model,
       json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.cache.read') AS cache, json_extract(data,'$.tokens.cache.write') AS cacheWrite,
       json_extract(data,'$.tokens.output') AS output, json_extract(data,'$.tokens.reasoning') AS reasoning,
       json_extract(data,'$.tokens.total') AS total
       FROM message WHERE json_valid(data) AND json_type(data,'$.tokens')='object'`);
    if (tables.some(({ name }) => name === 'session')) {
      const columns = new Set(
        (await all("PRAGMA table_info('session')")).map(({ name }) => name),
      );
      if (
        [
          'tokens_input',
          'tokens_cache_read',
          'tokens_cache_write',
          'tokens_output',
          'tokens_reasoning',
        ].every((name) => columns.has(name))
      )
        await query(`SELECT s.id AS sessionId,s.time_created AS timestamp,NULL AS model,s.tokens_input AS input,s.tokens_cache_read AS cache,
           s.tokens_cache_write AS cacheWrite,s.tokens_output AS output,s.tokens_reasoning AS reasoning,NULL AS total
           FROM session s WHERE s.tokens_input IS NOT NULL AND NOT EXISTS
           (SELECT 1 FROM message m WHERE m.session_id=s.id AND json_valid(m.data) AND json_type(m.data,'$.tokens')='object')`);
    }
    const invalid = await new Promise<number>((resolve, reject) =>
      db.get(
        'SELECT count(*) AS n FROM message WHERE NOT json_valid(data)',
        (e, row) => (e ? reject(e) : resolve(Number((row as Row).n))),
      ),
    );
    result.warnings += invalid;
    await exec('COMMIT');
  } finally {
    await new Promise<void>((resolve, reject) =>
      db.close((err) => (err ? reject(err) : resolve())),
    );
  }
  return result;
}

export const opencodeParser: Parser = {
  provider: 'opencode',
  async parse(path) {
    const before = await openCodeSnapshot(path);
    if (before.journal)
      return unavailable(
        'OpenCode práve zapisuje databázu. Skúste ju obnoviť neskôr.',
      );
    let temporary: string | undefined;
    try {
      let source = path;
      if (before.wal) {
        // SQLite replays committed WAL frames on a private copy. Opening the
        // original in immutable mode silently omits those token records.
        temporary = await mkdtemp(join(tmpdir(), 'lab-m4-opencode-'));
        source = join(temporary, 'opencode.db');
        if (!before.database) throw new Error('Missing OpenCode database');
        await copySnapshotFile(path, source, before.database);
        await copySnapshotFile(path + '-wal', source + '-wal', before.wal);
        if (before.signature !== (await openCodeSnapshot(path)).signature)
          return unavailable('Databáza OpenCode sa počas kopírovania zmenila. Skúste ju obnoviť.');
      }
      const result = await readDatabase(source, !before.wal);
      const after = await openCodeSnapshot(path);
      if (before.signature !== after.signature)
        return unavailable(
          'Databáza OpenCode sa počas čítania zmenila. Skúste ju obnoviť.',
        );
      return result;
    } catch {
      return unavailable(
        'Databáza OpenCode sa nedá bezpečne prečítať alebo používa nepodporovanú schému.',
      );
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  },
};

function unavailable(message: string): ParseResult {
  return {
    ...emptyResult(),
    warnings: 1,
    warningDetails: [message],
    partial: true,
    countRisk: 'under-count',
  };
}
