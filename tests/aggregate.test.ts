import { expect, it } from 'vitest';
import { totalTokens } from '../src/aggregate/index.js';
import { record } from './records.js';

it('returns zero for an empty collection', () => {
  expect(totalTokens([])).toBe(0);
});
it('adds input and output once, including cached and reasoning subsets', () => {
  expect(
    totalTokens([
      record,
      {
        ...record,
        inputTokens: 300,
        cachedInputTokens: 100,
        outputTokens: 100,
      },
    ]),
  ).toBe(1600);
});
