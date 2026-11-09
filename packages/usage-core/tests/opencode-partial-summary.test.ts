import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { settingsSchema } from '../src/core/settings.js';
import { summarize } from '../src/server/summary.js';
import { testTempDir } from './test-temp.js';

it('marks aggregate totals incomplete when an OpenCode source is unavailable', async () => {
  const dir = await testTempDir('opencode-summary-');
  const db = join(dir, 'opencode.db');
  const grok = join(dir, 'grok.jsonl');
  await writeFile(db, 'synthetic source');
  await writeFile(grok, `${JSON.stringify({ sid: 'synthetic', ts: '2025-01-01T00:00:00Z', msg: 'shell.turn.inference_done', ctx: { loop_index: 1, prompt_tokens: 10, cached_prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 1 } })}\n`);
  const disabled = { enabled: false, path: '' };
  const settings = settingsSchema.parse({
    agents: { codex: disabled, antigravity: disabled, 'grok-build': { enabled: true, path: grok }, opencode: { enabled: true, path: db } },
    usdToEur: 1,
    priceTable: {},
  });
  const summary = await summarize(settings);
  expect(summary.recordCount).toBe(1);
  expect(summary.sourcesIncomplete).toBe(true);
  expect(summary.agents.opencode?.partial).toBe(true);
  expect(summary.agents.opencode?.warningDetails?.[0]).toContain('nedá bezpečne prečítať');
  expect(summary.totals?.sessionsIncomplete).toBe(true);
  expect(summary.totals?.costIncomplete).toBe(true);
});
