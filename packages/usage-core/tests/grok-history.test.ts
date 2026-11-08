import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { handleRequest } from '../src/service/protocol.js';
import { testTempDir } from './test-temp.js';

it('reads completed Grok turns once from updates, keeping model totals and reported cost', async () => {
  const dir = await testTempDir('grok-history-');
  const sessions = join(dir, 'sessions');
  await mkdir(join(sessions, 'first'), { recursive: true });
  await mkdir(join(sessions, 'copy'));
  const totals = { inputTokens: 40, cachedReadTokens: 30, outputTokens: 5, reasoningTokens: 2, costUsdTicks: 1_250_000_000 };
  const record = (prompt: string) => JSON.stringify({
    params: {
      sessionId: 'synthetic-session',
      _meta: { agentTimestampMs: 1794000000000 },
      update: { sessionUpdate: 'turn_completed', prompt_id: prompt, usage: {
        ...totals, modelUsage: { 'synthetic-model': totals },
      } },
    },
  }) + '\n';
  await writeFile(join(sessions, 'first', 'updates.jsonl'), record('first'));
  await writeFile(join(sessions, 'copy', 'updates.jsonl'), record('first') + record('second'));
  await writeFile(join(sessions, 'first', 'chat_history.jsonl'), record('ignored'));
  const reply = await handleRequest({
    version: 1, requestId: 'synthetic', method: 'scan',
    params: { agent: 'grok-build', path: sessions, cachePath: join(dir, 'cache.sqlite') },
  });
  expect(reply.result.status).toBe('ok');
  expect(reply.result.records).toHaveLength(2);
  expect(reply.result.records[0]).toMatchObject({
    model: 'synthetic-model', input: 40, output: 5, cached: 30, reasoning: 2, costUsd: 0.125,
  });
  expect(reply.result.records[0]?.session).not.toBe('synthetic-session');
});
