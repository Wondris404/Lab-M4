import sqlite3 from 'sqlite3';
import { pathToFileURL } from 'node:url';
import { emptyResult, type Parser, type ParseResult } from './contracts.js';
import { assertSafeFile, count, str, time } from './shared.js';

type Row = Record<string, unknown>;
function mismatch(r: ParseResult, key: string): void {
  r.mismatchFields[key] = (r.mismatchFields[key] ?? 0) + 1;
}
function consume(row: Row, result: ParseResult): void {
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
  if (
    row.total !== null &&
    row.total !== undefined &&
    (typeof row.total !== 'number' || row.total !== expected)
  ) {
    result.warnings++;
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
  const cost =
    typeof row.cost === 'number' && Number.isFinite(row.cost) && row.cost >= 0
      ? row.cost
      : undefined;
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
    ...(cost !== undefined && { costUsd: cost }),
    costSource: cost !== undefined ? 'odhad' : 'neznáme',
  });
}
export const opencodeParser: Parser = {
  provider: 'opencode',
  async parse(path) {
    await assertSafeFile(path);
    const result = emptyResult();
    const uri = pathToFileURL(path).href + '?immutable=1&mode=ro';
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const d = new sqlite3.Database(
        uri,
        sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
        (err) => (err ? reject(err) : resolve(d)),
      );
    });
    const query = (sql: string) =>
      new Promise<void>((resolve, reject) => {
        db.each(
          sql,
          (err, row) => {
            if (err) {
              result.warnings++;
              return;
            }
            consume(row as Row, result);
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    try {
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
    } finally {
      await new Promise<void>((resolve, reject) =>
        db.close((err) => (err ? reject(err) : resolve())),
      );
    }
    return result;
  },
};
