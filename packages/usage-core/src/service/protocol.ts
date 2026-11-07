import { lstat } from 'node:fs/promises';
import { createHash, type Hash } from 'node:crypto';
import { scanCached } from './cache.js';
import { parserRegistry, type Parser } from '../parsers/index.js';
import { providers, type Provider } from '../core/types.js';
import type { ParseResult } from '../parsers/contracts.js';
import { normalizeRecord } from './normalize.js';

export interface ScanRequest {
  version: 1;
  requestId: string;
  method: 'scan';
  params: { agent: Provider; path: string; cachePath?: string; force?: boolean; offset?: number; limit?: number };
}

// Length framing prevents field-boundary collisions. Hash one field at a time,
// rather than materializing a second serialized copy of the whole scan.
function hashField(hash: Hash, value: string | number | boolean | undefined): void {
  if (value === undefined) {
    hash.update('u;');
    return;
  }
  const encoded = String(value);
  hash.update(`${typeof value}:${Buffer.byteLength(encoded, 'utf8')}:`);
  hash.update(encoded, 'utf8');
}

/** Identifies exactly the normalized content and outcome used by every page. */
export function scanSnapshotId(parsed: ParseResult): string {
  const hash = createHash('sha256');
  hashField(hash, 'lab-m4-usage-snapshot-v1');
  hashField(hash, Boolean(parsed.partial));
  hashField(hash, parsed.countRisk);
  hashField(hash, parsed.warnings);
  const warningDetails = parsed.warningDetails ?? [];
  hashField(hash, warningDetails.length);
  for (const warning of warningDetails) hashField(hash, warning);
  const mismatches = Object.entries(parsed.mismatchFields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  hashField(hash, mismatches.length);
  for (const [key, count] of mismatches) {
    hashField(hash, key);
    hashField(hash, count);
  }
  hashField(hash, parsed.records.length);
  for (const record of parsed.records) {
    for (const value of [record.provider, record.sessionId,
      record.sessionKnown, record.model, record.timestamp,
      record.inputTokens, record.cachedInputTokens, record.outputTokens, record.reasoningTokens,
      record.speed, record.costUsd, record.costSource]) hashField(hash, value);
    const warnings = record.warnings ?? [];
    hashField(hash, warnings.length);
    for (const warning of warnings) hashField(hash, warning);
  }
  hashField(hash, parsed.limits.length);
  for (const limit of parsed.limits) {
    hashField(hash, limit.timestamp);
    hashField(hash, limit.sessionId);
    for (const window of [limit.primary, limit.secondary]) {
      hashField(hash, Boolean(window));
      if (window) {
        hashField(hash, window.used_percent);
        hashField(hash, window.window_minutes);
        hashField(hash, window.resets_at);
      }
    }
  }
  return hash.digest('hex');
}

/** NEOVERENÉ: live SQLite WAL access may create SQLite shared-memory files. */
export async function handleRequest(input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Invalid request');
  const request = input as Partial<ScanRequest>;
  if (request.version !== 1 || typeof request.requestId !== 'string' || request.method !== 'scan' ||
      !request.params || !providers.includes(request.params.agent) || typeof request.params.path !== 'string') {
    throw new Error('Invalid request');
  }
  const { agent, path } = request.params;
  const offset = request.params.offset ?? 0;
  const limit = request.params.limit ?? 500;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid page');
  if (agent === 'antigravity') return { version: 1, requestId: request.requestId, result: { status: 'not-supported', records: [], warnings: ['NEOVERENÉ'] } };
  const parser: Parser = parserRegistry[agent];
  const info = await lstat(path);
  const parsed = (info.isFile() || (agent === 'codex' && info.isDirectory())) && request.params.cachePath
    ? await scanCached(parser, path, request.params.cachePath, request.params.force ?? false)
    : await parser.parse(path).then((result) => ({ ...result, records: result.records.map(normalizeRecord) }));
  return {
    version: 1, requestId: request.requestId,
    result: {
      status: parsed.partial ? 'partial' : 'ok',
      countRisk: parsed.countRisk ?? 'none',
      accounting: parsed.partial || parsed.countRisk ? 'orientational-estimate' : 'exact',
      snapshotId: scanSnapshotId(parsed), totalRecords: parsed.records.length, offset, warnings: [
        ...(parsed.warnings ? [`${parsed.warnings} parser warnings`] : []),
        ...(parsed.warningDetails ?? []),
        ...Object.entries(parsed.mismatchFields).map(([kind, count]) => `${kind}: ${count}`),
      ],
      records: parsed.records.slice(offset, offset + limit).map((r) => ({
        agent: r.provider, model: r.model, session: r.sessionId, sessionKnown: r.sessionKnown !== false, timestamp: r.timestamp,
        input: r.inputTokens, output: r.outputTokens, cached: r.cachedInputTokens,
        reasoning: r.reasoningTokens, costSource: r.costSource,
        ...(r.costUsd !== undefined && { costUsd: r.costUsd }), warnings: r.warnings ?? [],
      })),
    },
  };
}
