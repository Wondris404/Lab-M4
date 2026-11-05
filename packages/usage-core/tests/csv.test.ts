import { expect, it } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
it('escapes spreadsheet formulas and leaves unknown cost empty', () => {
  const csv = usageCsv([{ timestamp: '2025-01-01', agent: 'codex', model: '=1+1', session: 'example', input: 10, output: 2, cached: 3, reasoning: 1, warnings: [] }]);
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('""\r\n');
});
