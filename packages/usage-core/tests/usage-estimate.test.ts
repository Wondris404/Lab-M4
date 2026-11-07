import { expect, it } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
import { grokAccumulator } from '../src/parsers/grok-build.js';
import { describeAccounting } from '../src/server/summary.js';

it('keeps identical Grok rows and labels the total as an orientational estimate', () => {
  const accumulator = grokAccumulator();
  const line = JSON.stringify({
    sid: 'trace',
    ts: '2025-01-01T00:00:00Z',
    msg: 'shell.turn.inference_done',
    ctx: { session_id: 's', loop_index: 1, prompt_tokens: 10, cached_prompt_tokens: 0, completion_tokens: 2, reasoning_tokens: 0 },
  });
  accumulator.consume(JSON.stringify({ sid: 'trace', ctx: { session_id: 's' } }));
  accumulator.consume(line);
  accumulator.consume(line);
  const parsed = accumulator.result;
  expect(parsed.records).toHaveLength(2);
  expect(parsed.partial).toBe(true);
  expect(parsed.countRisk).toBe('double-count');
  const accounting = describeAccounting([parsed]);
  expect(accounting.kind).toBe('orientational-estimate');
  expect(accounting.replay).toBe(true);
  expect(accounting.doubleCount).toBe(true);
  expect(accounting.underCount).toBe(false);
  expect(accounting.note).toContain('Orientačný odhad');
  const csv = usageCsv([{
    timestamp: '2025-01-01', agent: 'grok-build', model: 'unknown', session: 's',
    input: 10, output: 2, cached: 0, reasoning: 0, warnings: [],
  }], true);
  expect(csv).toContain('scan_status;cost_status;accounting;cost_usd');
  expect(csv).toContain('orientational-estimate:replay-or-double-count-or-under-count');
});
