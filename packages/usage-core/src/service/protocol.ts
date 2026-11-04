import { parserRegistry, type Parser } from '../parsers/index.js';
import { providers, type Provider } from '../core/types.js';

export interface ScanRequest {
  version: 1;
  requestId: string;
  method: 'scan';
  params: { agent: Provider; path: string };
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
  if (agent === 'antigravity') return { version: 1, requestId: request.requestId, result: { status: 'not-supported', records: [], warnings: ['NEOVERENÉ'] } };
  const parser: Parser = parserRegistry[agent];
  const parsed = await parser.parse(path);
  return {
    version: 1, requestId: request.requestId,
    result: {
      status: 'ok', warnings: parsed.warnings ? [`${parsed.warnings} parser warnings`] : [],
      records: parsed.records.map((r) => ({
        agent: r.provider, model: r.model, session: r.sessionId, timestamp: r.timestamp,
        input: r.inputTokens, output: r.outputTokens, cached: r.cachedInputTokens,
        reasoning: r.reasoningTokens, ...(r.costUsd !== undefined && { cost: r.costUsd }), warnings: [],
      })),
    },
  };
}
