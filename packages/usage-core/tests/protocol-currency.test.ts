import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleRequest } from '../src/service/protocol.js';
import { emptyResult } from '../src/parsers/contracts.js';
import { codexParser } from '../src/parsers/codex.js';
import { testTempDir } from './test-temp.js';

it('sends known costs as USD without conversion or a EUR alias', async () => {
  const dir = await testTempDir('known-cost-');
  const path = join(dir, 'synthetic.jsonl');
  await writeFile(path, '');
  const parse = vi.spyOn(codexParser, 'parse').mockResolvedValue({
    ...emptyResult(), records: [{
      provider: 'codex', sessionId: 'synthetic', model: 'm',
      timestamp: '2025-01-01T00:00:00Z', inputTokens: 1, cachedInputTokens: 0,
      outputTokens: 1, reasoningTokens: 0, speed: 'unknown',
      costSource: 'odhad', costUsd: 1.25,
    }],
  });
  try {
    const response = await handleRequest({ version: 1, requestId: 'cost', method: 'scan', params: { agent: 'codex', path } });
    expect(response.result.records?.[0]).toMatchObject({ costUsd: 1.25 });
    expect(response.result.records?.[0]).not.toHaveProperty('costEur');
    expect(response.result.records?.[0]).not.toHaveProperty('cost');
  } finally { parse.mockRestore(); }
});
