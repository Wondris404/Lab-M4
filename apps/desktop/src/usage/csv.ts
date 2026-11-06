import type { UsageItem } from './UsageTab';

/** Escape spreadsheet formulas and delimiters; cost remains blank when unknown. */
function cell(value: string): string {
  const safe = /^(?:[\u0000-\u001f]|[\s\u0000-\u001f]*[=+\-@])/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function usageCsv(records: UsageItem[]): string {
  const rows = records.map(r => [r.timestamp, r.agent, r.model, r.session, String(r.input), String(r.output), String(r.cached), String(r.reasoning), r.costUsd === undefined ? '' : String(r.costUsd)].map(cell).join(';'));
  return ['timestamp;agent;model;session;input;output;cached;reasoning;cost_usd', ...rows].join('\r\n') + '\r\n';
}
