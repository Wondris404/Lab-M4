import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it('scans the compressed synthetic fixture through the packaged JSON-lines service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-'));
  try {
    const request = { version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'codex', path: resolve('packages/usage-core/fixtures/synthetic/codex.jsonl.zst'), cachePath: join(dir, 'cache.sqlite') } };
    const run = spawnSync(process.execPath, [resolve('apps/desktop/usage-service/main.cjs')], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) } });
    expect(run.status).toBe(0);
    const response = JSON.parse(run.stdout);
    expect(response.requestId).toBe('synthetic');
    expect(response.result.records).toHaveLength(1);
    expect(response.result.records[0].agent).toBe('codex');
    const nextPage = { ...request, params: { ...request.params, offset: 1, limit: 1 } };
    const pageRun = spawnSync(process.execPath, [resolve('apps/desktop/usage-service/main.cjs')], { input: `${JSON.stringify(nextPage)}\n`, encoding: 'utf8', env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) } });
    expect(JSON.parse(pageRun.stdout).result.records).toHaveLength(0);
    expect(JSON.parse(pageRun.stdout).result.totalRecords).toBe(1);
    const folderRequest = { ...request, params: { ...request.params, path: resolve('packages/usage-core/fixtures/synthetic') } };
    const folderRun = spawnSync(process.execPath, [resolve('apps/desktop/usage-service/main.cjs')], { input: `${JSON.stringify(folderRequest)}\n`, encoding: 'utf8', env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) } });
    expect(folderRun.status).toBe(0);
    expect(JSON.parse(folderRun.stdout).result.records).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
