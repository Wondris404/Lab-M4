import type { UsageItem } from './UsageTab';

/** Escape spreadsheet formulas and delimiters; cost remains blank when unknown. */
function cell(value: string): string {
  const safe = /^(?:[\u0000-\u001f]|[\s\u0000-\u001f]*[=+\-@])/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function usageCsv(records: UsageItem[], partial = false): string {
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
    ].map(cell).join(';');
  });
  return ['timestamp;agent;model;session;input;output;cached;reasoning;scan_status;cost_status;accounting;cost_usd', ...rows].join('\r\n') + '\r\n';
}
