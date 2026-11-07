import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';
import { settingsSchema } from '../src/core/settings.js';
import { grokAccumulator, grokBuildParser } from '../src/parsers/grok-build.js';
import { summarize } from '../src/server/summary.js';
import { scanCached } from '../src/service/cache.js';
import { emptyResult } from '../src/parsers/contracts.js';
import { testTempDir } from './test-temp.js';

const context = (session: string) => JSON.stringify({ sid: 'same-trace', ctx: { session_id: session } });
const usage = JSON.stringify({
  sid: 'same-trace',
  ts: '2025-01-01T00:00:00Z',
  msg: 'shell.turn.inference_done',
  ctx: { loop_index: 1, prompt_tokens: 10, cached_prompt_tokens: 0, completion_tokens: 2, reasoning_tokens: 0 },
});

it('preserves each record and reports ambiguous replays within each session', () => {
  const accumulator = grokAccumulator();
  for (const line of [context('first'), usage, usage, context('second'), usage, usage]) accumulator.consume(line);
  expect(accumulator.result.records.map((record) => record.sessionId)).toEqual(['first', 'first', 'second', 'second']);
  expect(accumulator.result).toMatchObject({ partial: true, warnings: 2, countRisk: 'double-count' });
  expect(accumulator.result.warningDetails?.[0]).toContain('orientačný odhad');
  expect(accumulator.result.warningDetails?.[0]).toContain('dvojité započítanie');
  expect(accumulator.result.warningDetails?.[0]).toContain('nepodpočítavajú');
  expect(accumulator.result.warningDetails?.[0]).toContain('len orientačný odhad');
});

it('ships the same orientational estimate from the parser, cache, summary and CSV', async () => {
  const dir = await testTempDir('grok-estimate-');
  const source = join(dir, 'grok.jsonl');
  const body = [context('first'), usage, usage, ''].join('\n');
  await writeFile(source, body);
  const parsed = await grokBuildParser.parse(source);
  expect(parsed.records.map((record) => record.inputTokens)).toEqual([10, 10]);
  expect(parsed.partial).toBe(true);
  expect(parsed.countRisk).toBe('double-count');
  const note = (parsed.warningDetails ?? []).join(' ');
  expect(note).toContain('replay');
  expect(note).toContain('dvojité započítanie');
  expect(note).toContain('nepodpočítavajú');
  expect(note).toContain('len orientačný odhad');

  const cached = await scanCached(grokBuildParser, source, join(dir, 'cache.sqlite'));
  expect(cached.records.map((record) => record.inputTokens)).toEqual([10, 10]);
  expect(cached.partial).toBe(true);
  expect(cached.countRisk).toBe('double-count');
  expect((cached.warningDetails ?? []).join(' ')).toContain('len orientačný odhad');

  const codex = join(dir, 'codex.jsonl');
  const counts = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1_000_000 };
  await writeFile(codex, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-test-1' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'model-test', speed: 'standard' } }),
    JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts, last_token_usage: counts } } }),
    '',
  ].join('\n'));
  const disabled = { enabled: false, path: '' };
  const usdToEur = 3;
  const summary = await summarize(settingsSchema.parse({
    agents: {
      codex: { enabled: true, path: codex },
      antigravity: disabled,
      opencode: disabled,
      'grok-build': { enabled: true, path: source },
    },
    usdToEur,
    priceTable: {
      'model-test': {
        standard: { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 },
      },
    },
  }));
  expect(summary.recordCount).toBe(3);
  expect(summary.sourcesIncomplete).toBe(true);
  expect(summary.totals?.costUsd).toBe(2);
  expect(summary.totals?.costEur).toBeNull();
  expect(summary.totals?.costEur).not.toBe(summary.totals?.costUsd as number * usdToEur);
  expect(summary.accounting.kind).toBe('orientational-estimate');
  expect(summary.accounting.replay).toBe(true);
  expect(summary.accounting.doubleCount).toBe(true);
  expect(summary.accounting.underCount).toBe(false);
  expect(summary.estimateNote).toContain('len orientačný odhad');
  expect(summary.estimateNote).toContain('nepodpočítavajú');

  const csv = usageCsv(parsed.records.map((record) => ({
    timestamp: record.timestamp,
    agent: record.provider,
    model: record.model,
    session: record.sessionId,
    input: record.inputTokens,
    output: record.outputTokens,
    cached: record.cachedInputTokens,
    reasoning: record.reasoningTokens,
    warnings: record.warnings ?? [],
  })), true, parsed.warningDetails ?? []);
  expect(csv).toContain('scan_status;cost_status');
  expect(csv).toContain('cost_status;accounting;cost_usd');
  expect(csv).toContain('len orientačný odhad');
  expect(csv).toContain('dvojité započítanie');
  expect(csv).toContain('nepodpočítavajú');
});

it('invalidates a cursor created with the previous deduplication semantics', async () => {
  const dir = await testTempDir('grok-session-');
  const source = join(dir, 'grok.jsonl');
  const cache = join(dir, 'cache.sqlite');
  await writeFile(source, [context('first'), usage, context('second'), usage, ''].join('\n'));
  const fresh = await scanCached(grokBuildParser, source, cache);
  expect(fresh.records).toHaveLength(2);

  // Simulate an otherwise valid unchanged v4 cursor created by the old parser.
  const oldKey = createHash('sha256').update(`grok-build\0${await realpath(source)}`).digest('hex') + ':v4';
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(cache, (error) => error ? reject(error) : resolve(instance));
  });
  try {
    await new Promise<void>((resolve, reject) => db.run(
      'UPDATE grok_cursor SET id = ?, result = ?',
      [oldKey, JSON.stringify(emptyResult())],
      (error) => error ? reject(error) : resolve(),
    ));
  } finally {
    await new Promise<void>((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
  const rescanned = await scanCached(grokBuildParser, source, cache);
  expect(rescanned.records).toHaveLength(2);
  expect(new Set(rescanned.records.map((record) => record.sessionId)).size).toBe(2);
});
