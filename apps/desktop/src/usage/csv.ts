import type { UsageItem } from './UsageTab';

const PARTIAL_ESTIMATE_NOTE =
  'Neistý súčet je len orientačný odhad. Čiastočný sken môže záznamy podhodnotiť, zopakovať alebo započítať dvakrát.';

/** Escape spreadsheet formulas and delimiters; cost remains blank when unknown. */
function cell(value: string): string {
  const safe = /^(?:[\u0000-\u001f]|[\s\u0000-\u001f]*[=+\-@])/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function usageCsv(records: UsageItem[], partial = false, warnings: readonly string[] = []): string {
  const supplied = warnings.map((warning) => warning.trim()).filter(Boolean).join(' | ');
  const uncertainty = /orientačný odhad/i.test(supplied)
    ? supplied
    : partial ? [supplied, PARTIAL_ESTIMATE_NOTE].filter(Boolean).join(' | ') : supplied;
  const rows = records.map((r) => {
    const costStatus = r.costUsd === undefined ? 'unknown'
      : r.costSource === 'odhad' ? 'estimated'
        : r.costSource === 'skutočné' ? 'reported' : 'unverified';
    return [
      r.timestamp, r.agent, r.model, r.sessionKnown === false ? '' : r.session,
      String(r.input), String(r.output), String(r.cached), String(r.reasoning),
      partial ? 'partial' : 'complete', costStatus,
      partial ? 'orientational-estimate:replay-or-double-count-or-under-count' : 'exact',
      r.costUsd === undefined ? '' : String(r.costUsd),
      uncertainty,
    ].map(cell).join(';');
  });
  return ['timestamp;agent;model;session;input;output;cached;reasoning;scan_status;cost_status;accounting;cost_usd;uncertainty', ...rows].join('\r\n') + '\r\n';
}
