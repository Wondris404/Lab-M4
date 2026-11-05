import { describe, expect, it } from 'vitest';
import { appendFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testTempDir } from './test-temp.js';
import sqlite3 from 'sqlite3';
import { codexParser } from '../src/parsers/codex.js';
import { grokBuildParser } from '../src/parsers/grok-build.js';
import { opencodeParser } from '../src/parsers/opencode.js';
import { scanCached } from '../src/service/cache.js';
import { handleRequest } from '../src/service/protocol.js';
import { summarize } from '../src/server/summary.js';
import { settingsSchema } from '../src/core/settings.js';
import example from '../config/settings.example.json';

const stamp = '2025-01-01T10:00:00Z';
const usage = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: 2,
  output_tokens: output,
  reasoning_output_tokens: 1,
  total_tokens: input + output,
});
const event = (total: unknown, last: unknown) => ({
  timestamp: stamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last },
    rate_limits: {
      primary: { used_percent: 20, window_minutes: 60, resets_at: 1750000000 },
    },
  },
});
async function temp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await testTempDir('agent-parsers-');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const record = (o: unknown) => JSON.stringify(o);

describe('codex', () => {
  it('links model, uses last usage, skips repeated totals and keeps limits', () =>
    temp(async (dir) => {
      const file = join(dir, 'session.jsonl');
      const a = usage(10, 3),
        b = usage(15, 5),
        last = usage(5, 2);
      const data = [
        { type: 'session_meta', payload: { id: 'sess-test-1' } },
        { type: 'turn_context', payload: { model: 'model-test' } },
        event(a, a),
        event(a, a),
        { type: 'turn_context', payload: { model: 'model-next' } },
        event(b, last),
      ];
      await writeFile(file, data.map(record).join('\n') + '\n{bad}\n');
      const r = await codexParser.parse(file);
      expect(
        r.records.map((x) => [x.model, x.inputTokens, x.outputTokens]),
      ).toEqual([
        ['model-test', 10, 3],
        ['model-next', 5, 2],
      ]);
      expect(r.records[0]?.sessionId).toBe('sess-test-1');
      expect(r.limits).toHaveLength(3);
      expect(r.limits[0]?.primary?.used_percent).toBe(20);
      expect(r.warnings).toBe(1);
    }));
  it('streams compressed synthetic fixture', async () => {
    const result = await codexParser.parse(
      'packages/usage-core/fixtures/synthetic/codex.jsonl.zst',
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sessionId).toBe('sess-test-1');
  });
  it('handles empty files and warns on missing fields', () =>
    temp(async (dir) => {
      const f = join(dir, 'empty.jsonl');
      await writeFile(f, '');
      expect((await codexParser.parse(f)).records).toEqual([]);
      await writeFile(f, record(event(usage(10, 3), usage(10, 3))) + '\n');
      expect((await codexParser.parse(f)).warnings).toBe(1);
    }));
  it('waits for a newline before parsing a complete trailing JSON object', () =>
    temp(async (dir) => {
      const file = join(dir, 'session.jsonl');
      const row = event(usage(10, 3), usage(10, 3));
      await writeFile(file, record({ type: 'session_meta', payload: { id: 'sess-test-1' } }) + '\n' + record(row));
      const incomplete = await codexParser.parse(file);
      expect(incomplete.records).toEqual([]);
      expect(incomplete.warnings).toBe(0);
      await appendFile(file, '\n');
      expect((await codexParser.parse(file)).records).toHaveLength(1);
    }));
});
describe('grok', () => {
  it('reports an oversized synthetic line as a partial scan', () =>
    temp(async (dir) => {
      const file = join(dir, 'grok.jsonl');
      await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
      const result = await grokBuildParser.parse(file);
      expect(result.records).toEqual([]);
      expect(result.warnings).toBe(1);
      expect(result.partial).toBe(true);
      const response = await handleRequest({ version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'grok-build', path: file } });
      expect(response.result.status).toBe('partial');
    }));
  it('links only within sid and counts duplicate and broken lines correctly', () =>
    temp(async (dir) => {
      const file = join(dir, 'grok.jsonl');
      const ctx = {
        loop_index: 1,
        prompt_tokens: 100,
        cached_prompt_tokens: 20,
        completion_tokens: 10,
        reasoning_tokens: 4,
      };
      const lines = [
        {
          sid: 'sess-test-1',
          ctx: { model_id: 'model-test', session_id: 'sess-test-1' },
        },
        {
          sid: 'sess-test-1',
          ts: stamp,
          msg: 'shell.turn.inference_done',
          ctx,
        },
        {
          sid: 'sess-test-1',
          ts: stamp,
          msg: 'shell.turn.inference_done',
          ctx,
        },
        {
          sid: 'sess-test-2',
          ts: stamp,
          msg: 'shell.turn.inference_done',
          ctx,
        },
        '{broken',
      ];
      await writeFile(
        file,
        lines.map((x) => (typeof x === 'string' ? x : record(x))).join('\n') + '\n',
      );
      const r = await grokBuildParser.parse(file);
      expect(r.records.map((x) => x.model)).toEqual(['model-test', 'unknown']);
      const response = await handleRequest({ version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'grok-build', path: file } });
      expect(response.result.records.map((item) => item.model)).toEqual(['unknown', 'unknown']);
      expect(response.result.records[0]?.warnings).toContain('MODEL_UNVERIFIED');
      expect(r.records).toHaveLength(2);
      expect(r.warnings).toBe(1);
    }));
  it('clears old model when a correlation id changes sessions', () =>
    temp(async (dir) => {
      const f = join(dir, 'grok.jsonl');
      const ctx = {
        loop_index: 1,
        prompt_tokens: 5,
        cached_prompt_tokens: 1,
        completion_tokens: 2,
        reasoning_tokens: 1,
      };
      const rows = [
        {
          sid: 'trace-test',
          ctx: { session_id: 'sess-test-1', model_id: 'model-test' },
        },
        { sid: 'trace-test', ctx: { session_id: 'sess-test-2' } },
        { sid: 'trace-test', ts: stamp, msg: 'shell.turn.inference_done', ctx },
      ];
      await writeFile(f, rows.map(record).join('\n') + '\n');
      const r = await grokBuildParser.parse(f);
      expect(r.records[0]?.sessionId).toBe('sess-test-2');
      expect(r.records[0]?.model).toBe('unknown');
    }));
});
function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((res, rej) => db.run(sql, (e) => (e ? rej(e) : res())));
}
function close(db: sqlite3.Database): Promise<void> {
  return new Promise((res, rej) => db.close((e) => (e ? rej(e) : res())));
}
async function makeDb(path: string) {
  const db = new sqlite3.Database(path);
  await run(
    db,
    'CREATE TABLE session(id TEXT,time_created INTEGER,tokens_input INTEGER,tokens_cache_read INTEGER,tokens_cache_write INTEGER,tokens_output INTEGER,tokens_reasoning INTEGER,cost REAL)',
  );
  await run(
    db,
    'CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)',
  );
  await run(
    db,
    `INSERT INTO session VALUES ('sess-test-1',1735725600000,100,20,3,10,4,0.5),('sess-test-2',1735725600000,5,1,0,2,1,0.1)`,
  );
  const data = JSON.stringify({
    modelID: 'model-test',
    tokens: {
      input: 100,
      output: 10,
      reasoning: 4,
      cache: { read: 20, write: 3 },
      total: 137,
    },
    cost: 0.5,
  });
  const bad = JSON.stringify({
    modelID: 'model-test',
    tokens: {
      input: 100,
      output: 10,
      reasoning: 4,
      cache: { read: 20, write: 3 },
      total: 1,
    },
    cost: 0.5,
  });
  await run(
    db,
    `INSERT INTO message VALUES ('sess-test-1',1735725600000,'${data}'),('sess-test-1',1735725660000,'${bad}'),('sess-test-1',1735725660001,'{bad')`,
  );
  await close(db);
}
describe('opencode', () => {
  it('normalizes separate counts, retains invalid totals with warnings, falls back only for sessions without messages', () =>
    temp(async (dir) => {
      const path = join(dir, 'opencode.db');
      await makeDb(path);
      const before = await readFile(path);
      const namesBefore = await readdir(dir);
      const r = await opencodeParser.parse(path);
      expect(await readFile(path)).toEqual(before);
      expect(await readdir(dir)).toEqual(namesBefore);
      expect(r.records).toHaveLength(3);
      const first = r.records[0]!;
      expect([
        first.inputTokens,
        first.cachedInputTokens,
        first.outputTokens,
        first.reasoningTokens,
      ]).toEqual([123, 20, 14, 4]);
      expect(first.costUsd).toBeUndefined();
      expect(first.costSource).toBe('neznáme');
      expect(r.mismatchFields.total).toBe(1);
      expect(r.records[1]?.warnings).toEqual(['TOTAL_MISMATCH']);
      const response = await handleRequest({ version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'opencode', path } });
      expect(response.result.records[1]?.warnings).toEqual(['TOTAL_MISMATCH']);
      expect(response.result.warnings).toContain('total: 1');
      expect(r.mismatchFields.total_less_than_components).toBe(1);
      expect(r.warnings).toBe(2);
      expect(
        r.records.filter((x) => x.sessionId === 'sess-test-2'),
      ).toHaveLength(1);
    }));
  it('reports a synthetic live WAL as partial without changing its files', () =>
    temp(async (dir) => {
      const path = join(dir, 'opencode.db');
      await makeDb(path);
      const writer = new sqlite3.Database(path);
      try {
        await run(writer, 'PRAGMA journal_mode=WAL');
        await run(writer, 'PRAGMA wal_autocheckpoint=0');
        await run(writer, "INSERT INTO session VALUES ('sess-test-wal',1735725600000,7,1,0,3,1,NULL)");
        const dbBefore = await readFile(path);
        const walBefore = await readFile(`${path}-wal`);
        const shmBefore = await readFile(`${path}-shm`);
        const names = (await readdir(dir)).sort();
        const direct = await opencodeParser.parse(path);
        const cached = await scanCached(opencodeParser, path, join(dir, 'cache.sqlite'));
        expect(direct.partial).toBe(true);
        expect(direct.warnings).toBe(1);
        expect(cached.partial).toBe(true);
        expect(cached.warnings).toBe(1);
        expect(await readFile(path)).toEqual(dbBefore);
        expect(await readFile(`${path}-wal`)).toEqual(walBefore);
        expect(await readFile(`${path}-shm`)).toEqual(shmBefore);
        expect((await readdir(dir)).sort()).toEqual(names);
      } finally {
        await close(writer);
      }
    }));
  it('fails safely for prohibited names and missing databases', async () => {
    await expect(opencodeParser.parse('auth.db')).rejects.toThrow();
    await expect(opencodeParser.parse('missing.db')).rejects.toThrow();
  });
});
it('summarizes only enabled agents and leaves unknown costs empty', () =>
  temp(async (dir) => {
    const f = join(dir, 'grok.jsonl');
    await writeFile(
      f,
      record({
        sid: 'sess-test-1',
        ts: stamp,
        msg: 'shell.turn.inference_done',
        ctx: {
          loop_index: 1,
          prompt_tokens: 100,
          cached_prompt_tokens: 20,
          completion_tokens: 10,
          reasoning_tokens: 4,
        },
      }) + '\n',
    );
    const config = structuredClone(example);
    config.agents['grok-build'] = { enabled: true, path: f };
    const summary = await summarize(settingsSchema.parse(config));
    expect(summary.recordCount).toBe(1);
    expect(summary.totals?.costUsd).toBeNull();
    expect(summary.totals?.inputTokens).toBe(100);
    expect(Object.keys(summary.agents)).toEqual(['grok-build']);
  }));

it('prices a known speed via settings and keeps warnings in the summary', () =>
  temp(async (dir) => {
    const f = join(dir, 'codex.jsonl');
    const counts = {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 3,
      reasoning_output_tokens: 1,
      total_tokens: 13,
    };
    const events = [
      { type: 'session_meta', payload: { id: 'sess-test-1' } },
      {
        type: 'turn_context',
        payload: { model: 'model-test', speed: 'standard' },
      },
      event(counts, counts),
    ];
    await writeFile(f, events.map(record).join('\n') + '\n{bad}\n');
    const config = structuredClone(example);
    config.agents.codex = { enabled: true, path: f };
    const price = {
      standard: {
        inputPerMillion: 2,
        cachedInputPerMillion: 1,
        outputPerMillion: 3,
      },
    };
    const settings = settingsSchema.parse({
      ...config,
      priceTable: { 'model-test': price },
    });
    const result = await summarize(settings);
    expect(result.recordCount).toBe(1);
    expect(result.warnings.codex).toBe(1);
    expect(result.totals?.sessions).toBe(1);
    expect(result.totals?.costUsd).toBeCloseTo(0.000027);
    expect(result.agents.codex?.records[0]?.costSource).toBe('odhad');
  }));
