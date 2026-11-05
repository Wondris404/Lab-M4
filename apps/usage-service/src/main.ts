import { createInterface } from 'node:readline';
import { handleRequest } from '../../../packages/usage-core/src/service/protocol.js';

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Request too large');
      const request = JSON.parse(line) as unknown;
      const result = await handleRequest(request);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ version: 1, error: 'Invalid or unreadable request' })}\n`);
    }
  }
}
void main();
