import { expect, it } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
it('escapes spreadsheet formulas and leaves unknown cost empty', () => {
  const csv = usageCsv([{ timestamp: '2025-01-01', agent: 'codex', model: '=1+1', session: 'example', input: 10, output: 2, cached: 3, reasoning: 1, warnings: [] }]);
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('""\r\n');
});

it('quotes semicolons, quotes, and line breaks and escapes formula prefixes', () => {
  const base = { timestamp: '2025-01-01', agent: 'codex' as const, session: 'example', input: 10, output: 2, cached: 3, reasoning: 1, warnings: [] };
  const csv = usageCsv([
    { ...base, model: '  =1+1' },
    { ...base, model: '\t+1' },
    { ...base, model: '\r\n-1' },
    { ...base, model: '@SUM(1)' },
    { ...base, model: '\tplain' },
    { ...base, model: 'a;"b"\nc' },
  ]);
  expect(csv).toContain('"\'  =1+1"');
  expect(csv).toContain('"\'\t+1"');
  expect(csv).toContain('"\'\r\n-1"');
  expect(csv).toContain('"\'@SUM(1)"');
  expect(csv).toContain('"\'\tplain"');
  expect(csv).toContain('"a;""b""\nc"');
});
