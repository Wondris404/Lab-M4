import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/service/protocol.js';
import { assertSafeFile } from '../src/parsers/shared.js';

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
});
