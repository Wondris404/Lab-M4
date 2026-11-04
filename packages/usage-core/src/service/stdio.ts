import { createInterface } from 'node:readline';
import { handleRequest } from './protocol.js';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Request too large');
    const result = await handleRequest(JSON.parse(line) as unknown);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ version: 1, error: 'Invalid or unreadable request' })}\n`);
  }
}
