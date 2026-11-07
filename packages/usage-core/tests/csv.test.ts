import { expect, it } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
it('labels known costs in USD and preserves their value', () => {
  const csv = usageCsv([{ timestamp: '2025-01-01', agent: 'codex', model: 'm', session: 'example', input: 10, output: 2, cached: 0, reasoning: 0, costUsd: 1.25, warnings: [] }]);
  expect(csv).toContain('cost_usd');
  expect(csv).toContain('"1.25"');
});
it('escapes spreadsheet formulas and leaves unknown cost empty', () => {
  const csv = usageCsv([{ timestamp: '2025-01-01', agent: 'codex', model: '=1+1', session: 'example', input: 10, output: 2, cached: 3, reasoning: 1, warnings: [] }]);
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('""\r\n');
});

it('keeps partial scan status and price provenance in a portable export', () => {
  const row = { timestamp: '2025-01-01', agent: 'codex', model: 'm', session: 'example', input: 10, output: 2, cached: 0, reasoning: 0, warnings: [] };
  const csv = usageCsv([row, { ...row, costUsd: 0, costSource: 'odhad' }], true);
  expect(csv).toContain('scan_status;cost_status;accounting;cost_usd');
  expect(csv).toContain('"partial";"unknown";"orientational-estimate:replay-or-double-count-or-under-count";""');
  expect(csv).toContain('"partial";"estimated";"orientational-estimate:replay-or-double-count-or-under-count";"0"');
  expect(csv).toContain('len orientačný odhad');
  expect(csv).toContain('započítať dvakrát');
  expect(csv).toContain('podhodnotiť');
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
