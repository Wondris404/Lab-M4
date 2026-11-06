import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('prints aggregate synthetic usage without session identifiers or invented cost', () => {
  const run = spawnSync(process.execPath, [
    resolve('scripts/usage-cli.mjs'), 'codex',
    resolve('packages/usage-core/fixtures/synthetic/codex.jsonl.zst'),
  ], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({
    status: 'ok', records: 1, inputTokens: '10', outputTokens: '4', cost: 'unknown',
  });
  expect(run.stdout).not.toContain('sess-test-1');
}, 30000);
