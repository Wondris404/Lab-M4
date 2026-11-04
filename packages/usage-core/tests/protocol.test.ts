import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/service/protocol.js';

describe('usage protocol', () => {
  it('reports unsupported Antigravity without reading files', async () => {
    const result = await handleRequest({ version: 1, requestId: 'test', method: 'scan', params: { agent: 'antigravity', path: '' } });
    expect(result.result.status).toBe('not-supported');
  });
  it('rejects unsupported protocol versions', async () => {
    await expect(handleRequest({ version: 2 })).rejects.toThrow();
  });
});
