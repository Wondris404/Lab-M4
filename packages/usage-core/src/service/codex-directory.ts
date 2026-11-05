import { createHash } from 'node:crypto';
import sqlite3 from 'sqlite3';
import { emptyResult, type ParseResult } from '../parsers/contracts.js';
import {
  codexAccumulator,
  type CodexCursorState,
} from '../parsers/codex-cursor.js';
import {
  findCodexFiles,
  lines,
  newExpansionBudget,
} from '../parsers/shared.js';
import { normalizeRecord } from './normalize.js';
import { scanJsonlAppend, type CursorResult } from './grok-cursor.js';

/** Incremental per-file scan, deduplicated using the same session/total key as Codex. */
export async function scanCodexDirectory(
  db: sqlite3.Database,
  sourceKey: string,
  path: string,
  pseudonym: (id: string) => string,
  force: boolean,
): Promise<ParseResult> {
  const result = emptyResult();
  const seen = new Set<string>();
  const budget = newExpansionBudget();
  for await (const file of findCodexFiles(path)) {
    let parsed: CursorResult;
    if (/\.zst$/i.test(file)) {
      const accumulator = codexAccumulator(undefined, pseudonym);
      try {
        for await (const line of lines(file, budget)) accumulator.consume(line);
        parsed = {
          ...accumulator.result,
          records: accumulator.result.records.map(normalizeRecord),
          _fingerprints: accumulator.fingerprints,
        };
      } catch {
        parsed = { ...emptyResult(), warnings: 1, partial: true };
      }
    } else {
      const key = createHash('sha256')
        .update(`${sourceKey}\0${file}`)
        .digest('hex');
      parsed = await scanJsonlAppend(
        db,
        `${key}:v2`,
        file,
        (previous) =>
          codexAccumulator(previous as CodexCursorState | undefined, pseudonym),
        force,
      );
    }
    if (parsed.records.length !== (parsed._fingerprints?.length ?? 0))
      throw new Error('Invalid Codex cursor');
    for (let i = 0; i < parsed.records.length; i++) {
      const fingerprint = parsed._fingerprints![i]!;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      result.records.push(parsed.records[i]!);
    }
    result.limits.push(...parsed.limits);
    result.warnings += parsed.warnings;
    if (parsed.partial) result.partial = true;
  }
  return result;
}
