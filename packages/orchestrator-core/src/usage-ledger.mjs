// Codex app-server 0.166.0 reports cumulative totals per thread. This module
// consumes those notifications; it does not launch an agent or infer billing.
const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

function validTotals(value) {
  if (!value || fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
  const combined = value.inputTokens + value.outputTokens;
  return Number.isSafeInteger(combined) && value.totalTokens === combined &&
    value.cachedInputTokens <= value.inputTokens && value.reasoningOutputTokens <= value.outputTokens;
}

export function createUsageLedger({ tokenLimit = 100_000, costLimitEur = 5 } = {}) {
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0 ||
      !Number.isFinite(costLimitEur) || costLimitEur <= 0) throw new Error('Invalid budget');
  return { version: 1, tokenLimit, costLimitEur, threads: {}, cost: { kind: 'unknown' } };
}

export function recordCodexUsage(ledger, event) {
  if (ledger?.version !== 1 || event?.method !== 'thread/tokenUsage/updated')
    throw new Error('Invalid usage event');
  const { threadId, tokenUsage } = event.params ?? {};
  if (typeof threadId !== 'string' || !threadId || threadId.length > 256 || !tokenUsage?.total)
    throw new Error('Invalid usage event');
  const current = tokenUsage.total;
  if (!validTotals(current))
    throw new Error('Invalid token totals');
  // Validate the complete existing ledger before modifying it. A corrupt
  // unrelated thread must not cause a later failure after this update sticks.
  usageBudgetStatus(ledger);
  const previous = Object.hasOwn(ledger.threads, threadId) ? ledger.threads[threadId] : undefined;
  if (previous && fields.some((key) => current[key] < previous[key]))
    throw new Error('Token total decreased; reconcile before continuing');
  // These snapshots are cumulative and the detailed counts are subsets of
  // input/output. Their increments cannot exceed their parent increments. If
  // the provider revises old classification, reconcile instead of accepting
  // an internally contradictory cumulative series as trusted accounting.
  if (previous && (
    current.cachedInputTokens - previous.cachedInputTokens > current.inputTokens - previous.inputTokens ||
    current.reasoningOutputTokens - previous.reasoningOutputTokens > current.outputTokens - previous.outputTokens
  )) throw new Error('Token subset increment inconsistent; reconcile before continuing');
  const next = Object.fromEntries(fields.map((key) => [key, current[key]]));
  const others = Object.entries(ledger.threads).filter(([id]) => id !== threadId);
  const aggregate = others.reduce((sum, [, usage]) => sum + usage.totalTokens, current.totalTokens);
  if (!Number.isSafeInteger(aggregate)) throw new Error('Invalid aggregate');
  // Define a data property even for untrusted IDs such as __proto__.
  Object.defineProperty(ledger.threads, threadId, { value: next, enumerable: true, writable: true, configurable: true });
  return usageBudgetStatus(ledger);
}

export function usageBudgetStatus(ledger) {
  if (ledger?.version !== 1) throw new Error('Invalid ledger');
  const tokens = Object.values(ledger.threads).reduce((sum, usage) => {
    if (!validTotals(usage) ||
        !Number.isSafeInteger(sum + usage.totalTokens)) throw new Error('Invalid aggregate');
    return sum + usage.totalTokens;
  }, 0);
  return {
    reportedTokens: tokens,
    tokenLimit: ledger.tokenLimit,
    cost: ledger.cost,
    costLimitEur: ledger.costLimitEur,
    subscriptionBilling: 'unknown',
    // No trusted cost integration exists yet, so this ledger cannot authorize
    // a paid turn even if its serialized cost field has been modified.
    canSchedule: false,
  };
}
