import { loadSettings, type Settings } from '../core/settings.js';
import { estimateCost } from '../pricing/index.js';
import { parserRegistry, type ParseResult } from '../parsers/index.js';
import type { Provider } from '../core/types.js';

export function describeAccounting(results: Array<ParseResult | undefined>) {
  const present = results.filter((result): result is ParseResult => Boolean(result));
  const doubleCount = present.some((result) => result.countRisk === 'double-count');
  const underCount = present.some((result) => result.countRisk === 'under-count' || (result.partial && result.countRisk !== 'double-count'));
  const uncertain = doubleCount || underCount || present.some((result) => result.partial);
  return {
    kind: uncertain ? 'orientational-estimate' as const : 'exact' as const,
    replay: doubleCount,
    doubleCount,
    underCount,
    note: uncertain
      ? 'Orientačný odhad, nie fakturácia. Replay zhodných Grok riadkov sa môže započítať dvakrát. Chýbajúci alebo poškodený zdroj sa podpočíta.'
      : 'Súčet neoznačuje replay, dvojité započítanie ani podpočítanie.',
  };
}

export async function summarize(settings: Settings) {
  const agents: Partial<Record<Provider, ParseResult>> = {};
  const errors: Partial<Record<Provider, string>> = {};
  for (const provider of Object.keys(settings.agents) as Provider[]) {
    const agent = settings.agents[provider];
    if (!agent.enabled) continue;
    try {
      const parsed = await parserRegistry[provider].parse(agent.path);
      parsed.records = parsed.records.map((record) => {
        if (record.costUsd !== undefined) return record;
        const estimate = estimateCost(record, settings.priceTable);
        return estimate === null
          ? record
          : { ...record, costUsd: estimate, costSource: 'odhad' as const };
      });
      agents[provider] = parsed;
    } catch {
      errors[provider] = 'Zdroj sa nepodarilo prečítať.';
    }
  }
  const records = Object.values(agents).flatMap((a) => a.records);
  const known = records.filter((r) => r.costUsd !== undefined);
  const incomplete = Object.keys(errors).length > 0 || Object.values(agents).some((agent) => agent.partial);
  const costUsd = known.length
    ? known.reduce((n, r) => n + (r.costUsd ?? 0), 0)
    : null;
  return {
    recordCount: records.length,
    sourcesIncomplete: incomplete,
    totals: records.length
      ? {
          sessions: new Set(
            records
              .filter((r) => r.sessionKnown !== false)
              .map((r) => JSON.stringify([r.provider, r.sessionId])),
          ).size,
          sessionsIncomplete:
            incomplete ||
            records.some((r) => r.sessionKnown === false),
          totalTokens: records.reduce(
            (n, r) => n + r.inputTokens + r.outputTokens,
            0,
          ),
          inputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
          cachedInputTokens: records.reduce(
            (n, r) => n + r.cachedInputTokens,
            0,
          ),
          outputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
          reasoningTokens: records.reduce((n, r) => n + r.reasoningTokens, 0),
          costUsd,
          // Keep the legacy response shape until there is a verified FX rate.
          costEur: null,
          costIncomplete:
            incomplete || known.length !== records.length,
          costSource: known.length
            ? known.some((r) => r.costSource === 'odhad')
              ? 'odhad'
              : 'skutočné'
            : 'neznáme',
          accounting: describeAccounting(Object.values(agents)),
        }
      : null,
    warnings: Object.fromEntries(
      Object.entries(agents).map(([k, v]) => [k, v.warnings]),
    ),
    agents,
    errors,
  };
}
export async function summaryFromFile(path: string) {
  return summarize(await loadSettings(path));
}
