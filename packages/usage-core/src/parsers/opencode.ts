import sqlite3 from 'sqlite3';
import { lstat } from 'node:fs/promises';
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
async function readDatabase(path: string): Promise<ParseResult> {
  await assertSafeFile(path);
  // Live WAL readers may write SHM even when the DB is opened read-only.
  // NEOVERENÉ: a concurrent writer could create WAL after this check.
  for (const suffix of ['-wal', '-shm']) {
    try {
      await lstat(`${path}${suffix}`);
      return { ...emptyResult(), warnings: 1, partial: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const result = emptyResult();
  const uri = pathToFileURL(path).href + '?mode=ro';
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
  try {
    // query_only is connection-local; the transaction keeps both reads consistent.
    // https://www.sqlite.org/pragma.html#pragma_query_only
    await exec('PRAGMA query_only = ON; BEGIN');
    await query(`SELECT session_id AS sessionId, time_created AS timestamp, json_extract(data,'$.modelID') AS model,
       json_extract(data,'$.tokens.input') AS input, json_extract(data,'$.tokens.cache.read') AS cache, json_extract(data,'$.tokens.cache.write') AS cacheWrite,
       json_extract(data,'$.tokens.output') AS output, json_extract(data,'$.tokens.reasoning') AS reasoning,
       json_extract(data,'$.tokens.total') AS total, json_extract(data,'$.cost') AS cost
       FROM message WHERE json_valid(data) AND json_type(data,'$.tokens')='object'`);
    await query(`SELECT s.id AS sessionId,s.time_created AS timestamp,NULL AS model,s.tokens_input AS input,s.tokens_cache_read AS cache,
       s.tokens_cache_write AS cacheWrite,s.tokens_output AS output,s.tokens_reasoning AS reasoning,NULL AS total,s.cost AS cost
       FROM session s WHERE s.tokens_input IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM message m WHERE m.session_id=s.id AND json_valid(m.data) AND json_type(m.data,'$.tokens')='object')`);
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
    await assertSafeFile(path);
    // Opening SQLite read-only can still create or modify shared-memory files.
    // A check for -wal/-shm before opening cannot prevent a concurrent writer
    // from creating them afterwards. Keep reads disabled until a supported,
    // consistent no-source-write snapshot mechanism is implemented.
    if (!safeSnapshotAvailable()) return opencodeReadUnavailable();
    for (let attempt = 0; ; attempt++) {
      try {
        return await readDatabase(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') throw error;
        if (attempt === 2)
          return { ...emptyResult(), warnings: 1, partial: true };
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  },
};

function safeSnapshotAvailable(): boolean {
  return false;
}

export function opencodeReadUnavailable(): ParseResult {
  return {
    ...emptyResult(),
    warnings: 1,
    warningDetails: ['OpenCode je dočasne nedostupný: chýba bezpečný SQLite snapshot bez zápisu do zdroja.'],
    partial: true,
    countRisk: 'under-count',
  };
}
