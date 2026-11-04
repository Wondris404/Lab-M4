import { describe, expect, it } from 'vitest';
import { estimateCost } from '../src/pricing/index.js';
import { record } from './records.js';

const prices = {
  'test-model': {
    standard: {
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 8,
    },
    fast: {
      inputPerMillion: 4,
      cachedInputPerMillion: 1,
      outputPerMillion: 16,
    },
  },
};

describe('pricing', () => {
  it('prices uncached input, cache and output without counting reasoning twice', () => {
    expect(estimateCost(record, prices)).toBeCloseTo(0.003);
  });
  it('uses the explicit fast rate', () => {
    expect(estimateCost({ ...record, speed: 'fast' }, prices)).toBeCloseTo(
      0.006,
    );
  });
  it('returns null for an unknown model or speed', () => {
    expect(estimateCost({ ...record, model: 'missing' }, prices)).toBeNull();
    expect(estimateCost({ ...record, speed: 'unknown' }, prices)).toBeNull();
    expect(
      estimateCost(
        { ...record, speed: 'fast' },
        { 'test-model': { standard: prices['test-model'].standard } },
      ),
    ).toBeNull();
  });
  it('returns zero for a known model with zero usage', () => {
    expect(
      estimateCost(
        {
          ...record,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        prices,
      ),
    ).toBe(0);
  });
  it('validates tokens before returning for unknown pricing', () => {
    expect(() =>
      estimateCost({ ...record, model: 'missing', inputTokens: -1 }, prices),
    ).toThrow(RangeError);
    expect(() =>
      estimateCost(
        { ...record, speed: 'unknown', cachedInputTokens: 1001 },
        prices,
      ),
    ).toThrow(RangeError);
    expect(() =>
      estimateCost(
        { ...record, speed: 'fast', reasoningTokens: 201 },
        { 'test-model': { standard: prices['test-model'].standard } },
      ),
    ).toThrow(RangeError);
  });
  it('rejects invalid token subsets', () => {
    expect(() =>
      estimateCost({ ...record, cachedInputTokens: 1001 }, prices),
    ).toThrow(RangeError);
  });
});
