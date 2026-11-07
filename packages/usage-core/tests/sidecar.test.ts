import { readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { testTempDir } from './test-temp.js';
import { expect, it } from 'vitest';

it('scans the compressed synthetic fixture through the packaged JSON-lines service', async () => {
  const dir = await testTempDir('sidecar-');
  try {
    const request = { version: 1, requestId: 'synthetic', method: 'scan', params: { agent: 'codex', path: resolve('packages/usage-core/fixtures/synthetic/codex.jsonl.zst'), cachePath: join(dir, 'cache.sqlite') } };
    const stage = resolve('apps/desktop/usage-service');
    const node = join(stage, process.platform === 'win32' ? 'node.exe' : 'node');
    const scan = (input: typeof request) => {
      const run = spawnSync(node, [join(stage, 'main.cjs')], {
        input: `${JSON.stringify(input)}\n`,
        encoding: 'utf8',
        cwd: stage,
        timeout: 5000,
        env: { ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) },
      });
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(0);
      return JSON.parse(run.stdout);
    };
    const response = scan(request);
    expect(response.requestId).toBe('synthetic');
    expect(response.result.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(response.result.records).toHaveLength(1);
    expect(response.result.records[0].agent).toBe('codex');
    const nextPage = { ...request, params: { ...request.params, offset: 1, limit: 1 } };
    const nextResponse = scan(nextPage);
    expect(nextResponse.result.records).toHaveLength(0);
    expect(nextResponse.result.totalRecords).toBe(1);
    expect(nextResponse.result.snapshotId).toBe(response.result.snapshotId);
    const folderRequest = { ...request, params: { ...request.params, path: resolve('packages/usage-core/fixtures/synthetic') } };
    expect(scan(folderRequest).result.records).toHaveLength(1);
    const damaged = join(dir, 'damaged.jsonl.zst');
    const bytes = await readFile(request.params.path);
    await writeFile(damaged, bytes.subarray(0, bytes.length - 1));
    expect(scan({ ...request, params: { ...request.params, path: damaged } }).result)
      .toMatchObject({ status: 'partial', records: [] });
    expect(scan({ ...request, params: { ...request.params, path: join(dir, 'missing.jsonl') } }))
      .toEqual({ version: 1, error: 'INVALID_OR_UNREADABLE' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
