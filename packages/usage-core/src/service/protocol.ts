import { lstat } from 'node:fs/promises';
import { scanCached } from './cache.js';
import { parserRegistry, type Parser } from '../parsers/index.js';
import { providers, type Provider } from '../core/types.js';
import { normalizeRecord } from './normalize.js';

export interface ScanRequest {
  version: 1;
  requestId: string;
  method: 'scan';
  params: { agent: Provider; path: string; cachePath?: string; force?: boolean; offset?: number; limit?: number };
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
      status: parsed.partial ? 'partial' : 'ok', totalRecords: parsed.records.length, offset, warnings: [
        ...(parsed.warnings ? [`${parsed.warnings} parser warnings`] : []),
        ...Object.entries(parsed.mismatchFields).map(([kind, count]) => `${kind}: ${count}`),
      ],
      records: parsed.records.slice(offset, offset + limit).map((r) => ({
        agent: r.provider, model: r.model, session: r.sessionId, timestamp: r.timestamp,
        input: r.inputTokens, output: r.outputTokens, cached: r.cachedInputTokens,
        reasoning: r.reasoningTokens, ...(r.costUsd !== undefined && { cost: r.costUsd }), warnings: r.warnings ?? [],
      })),
    },
  };
}
