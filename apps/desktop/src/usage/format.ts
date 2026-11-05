/** Slovak product formatting with explicit dot grouping. */
export function formatFull(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const [integer, fraction] = String(value).split('.');
  const grouped = (integer ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction ? `${grouped},${fraction}` : grouped;
}
export function formatShort(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const units = [[1e12, ' bil'], [1e9, ' mld'], [1e6, ' mil'], [1e3, 'k']] as const;
  for (const [divisor, suffix] of units) {
    if (abs >= divisor || (divisor > 1e3 && abs >= divisor * 0.99995)) {
      return `${formatFull(Math.round(value / divisor * 10) / 10)}${suffix}`;
    }
  }
  return formatFull(value);
}
