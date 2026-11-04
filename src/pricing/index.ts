import type { PriceTable } from '../core/settings.js';
import type { UsageRecord } from '../core/types.js';

/** USD estimate only. Rates are per million tokens; reasoning is included in output. */
export function estimateCost(
  record: UsageRecord,
  prices: PriceTable,
): number | null {
  if (record.speed === 'unknown' || !Object.hasOwn(prices, record.model))
    return null;
  const price = prices[record.model]?.[record.speed];
  if (!price) return null;
  const counts = [
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.reasoningTokens,
  ];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    record.cachedInputTokens > record.inputTokens ||
    record.reasoningTokens > record.outputTokens
  ) {
    throw new RangeError('Neplatné počty tokenov.');
  }
  return (
    ((record.inputTokens - record.cachedInputTokens) * price.inputPerMillion +
      record.cachedInputTokens * price.cachedInputPerMillion +
      record.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
