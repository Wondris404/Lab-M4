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
});
