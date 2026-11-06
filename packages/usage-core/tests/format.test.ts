import { describe, expect, it } from 'vitest';
import { formatFull, formatShort } from '../../../apps/desktop/src/usage/format.js';
describe('Slovak usage formatting', () => {
  it('formats full and compact numbers', () => {
    expect(formatFull(1234567)).toBe('1.234.567');
    expect(formatShort(1500)).toBe('1,5k');
    expect(formatShort(2300000)).toBe('2,3 mil');
    expect(formatShort(1e9)).toBe('1 mld');
    expect(formatShort(1e12)).toBe('1 bil');
    expect(formatShort(999)).toBe('999');
    expect(formatShort(999950)).toBe('1 mil');
  });

  it('expands scientific notation and preserves sign and decimal digits', () => {
    expect(formatFull(0.0000001)).toBe('0,0000001');
    expect(formatFull(-0.0000001)).toBe('-0,0000001');
    expect(formatFull(1e21)).toBe('1.000.000.000.000.000.000.000');
    expect(formatFull(-1234567.25)).toBe('-1.234.567,25');
    expect(formatFull(NaN)).toBe('—');
    expect(formatFull(Infinity)).toBe('—');
  });

  it('rounds symmetrically and promotes at compact unit boundaries', () => {
    expect(formatShort(999)).toBe('999');
    expect(formatShort(1000)).toBe('1k');
    expect(formatShort(-1500)).toBe('-1,5k');
    expect(formatShort(-1550)).toBe('-1,6k');
    expect(formatShort(999949)).toBe('999,9k');
    expect(formatShort(999950)).toBe('1 mil');
    expect(formatShort(-999950)).toBe('-1 mil');
    expect(formatShort(999949999)).toBe('999,9 mil');
    expect(formatShort(999950000)).toBe('1 mld');
    expect(formatShort(999950000000)).toBe('1 bil');
    expect(formatShort(-Infinity)).toBe('—');
  });
});
