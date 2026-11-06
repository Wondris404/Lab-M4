import { describe, expect, it } from 'vitest';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handleRequest, scanSnapshotId } from '../src/service/protocol.js';
import { emptyResult } from '../src/parsers/contracts.js';
import { assertSafeFile } from '../src/parsers/shared.js';
import { testTempDir } from './test-temp.js';

describe('usage protocol', () => {
  it('reports unsupported Antigravity without reading files', async () => {
    const result = await handleRequest({ version: 1, requestId: 'test', method: 'scan', params: { agent: 'antigravity', path: '' } });
    expect(result.result.status).toBe('not-supported');
  });
  it('rejects sensitive directory names before opening the source', async () => {
    await expect(assertSafeFile('credentials/usage.jsonl')).rejects.toThrow('Nepovolená cesta');
    await expect(assertSafeFile('keys.jsonl')).rejects.toThrow('Nepovolená cesta');
  });
  it('rejects unsupported protocol versions', async () => {
    await expect(handleRequest({ version: 2 })).rejects.toThrow();
  });
  it('binds every page to the whole normalized scan and changes after an append', async () => {
    const dir = await testTempDir('snapshot-');
    const path = join(dir, 'synthetic.jsonl');
    const event = (total: number) => JSON.stringify({
      timestamp: '2025-01-01T00:00:00Z', type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: total },
        last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
      } },
    }) + '\n';
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic' } }) + '\n' + event(1) + event(2));
    const request = (offset: number) => ({ version: 1, requestId: `page-${offset}`, method: 'scan', params: { agent: 'codex', path, offset, limit: 1 } });
    const first = (await handleRequest(request(0))).result;
    const second = (await handleRequest(request(1))).result;
    expect(first.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    await appendFile(path, event(3));
    const changed = (await handleRequest(request(1))).result;
    expect(changed.snapshotId).not.toBe(first.snapshotId);
    expect(changed.totalRecords).toBe(3);
  });
  it('includes scan status, warnings, record fields and limits in the snapshot', () => {
    const base = emptyResult();
    base.records.push({ provider: 'codex', sessionId: 'synthetic', model: 'm', timestamp: '2025-01-01T00:00:00Z', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, speed: 'unknown', costSource: 'neznáme' });
    const id = scanSnapshotId(base);
    expect(scanSnapshotId(structuredClone(base))).toBe(id);
    expect(scanSnapshotId({ ...base, partial: true })).not.toBe(id);
    expect(scanSnapshotId({ ...base, warnings: 1 })).not.toBe(id);
    expect(scanSnapshotId({ ...base, warningDetails: ['partial'] })).not.toBe(id);
    expect(scanSnapshotId({ ...base, mismatchFields: { total: 1 } })).not.toBe(id);
    expect(scanSnapshotId({ ...base, records: [{ ...base.records[0]!, inputTokens: 2 }] })).not.toBe(id);
    expect(scanSnapshotId({ ...base, limits: [{ timestamp: '2025-01-01T00:00:00Z', sessionId: 'synthetic', primary: { used_percent: 1, window_minutes: 60, resets_at: 1 } }] })).not.toBe(id);
  });
});
