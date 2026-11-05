import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExpansionLimitError, lines } from '../src/parsers/shared.js';

const fixture = resolve(
  'packages/usage-core/fixtures/synthetic/codex.jsonl.zst',
);

async function read(budget: { remaining: number; perFile: number }) {
  const result: string[] = [];
  for await (const line of lines(fixture, budget)) result.push(line);
  return result;
}

describe('compressed usage expansion limits', () => {
  it('rejects a fixture larger than its per-file expansion allowance', async () => {
    await expect(
      read({ remaining: 100_000, perFile: 1 }),
    ).rejects.toBeInstanceOf(ExpansionLimitError);
  });

  it('charges a shared scan allowance across compressed files', async () => {
    const budget = { remaining: 100_000, perFile: 100_000 };
    expect((await read(budget)).length).toBeGreaterThan(0);
    const used = 100_000 - budget.remaining;
    budget.remaining = used - 1;
    await expect(read(budget)).rejects.toBeInstanceOf(ExpansionLimitError);
    expect(budget.remaining).toBe(0);
  });
});
