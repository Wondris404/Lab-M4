/** Slovak product formatting with explicit dot grouping. */
export function formatFull(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const [mantissa = '0', exponentText] = String(Math.abs(value)).split('e');
  const [whole = '0', decimal = ''] = mantissa.split('.');
  const digits = whole + decimal;
  const point = whole.length + Number(exponentText ?? 0);
  const expanded = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${'0'.repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer = '0', fraction] = expanded.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + (fraction ? `${grouped},${fraction}` : grouped);
}
export function formatShort(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const units = [[1e3, 'k'], [1e6, ' mil'], [1e9, ' mld'], [1e12, ' bil']] as const;
  for (let i = units.length - 1; i >= 0; i--) {
    const [divisor, suffix] = units[i]!;
    if (abs >= divisor) {
      const rounded = Math.round(abs / divisor * 10) / 10;
      if (rounded >= 1000 && i + 1 < units.length)
        return `${value < 0 ? '-' : ''}1${units[i + 1]![1]}`;
      return `${value < 0 ? '-' : ''}${formatFull(rounded)}${suffix}`;
    }
  }
  return formatFull(value);
}
