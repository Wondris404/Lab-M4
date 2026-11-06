import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { data } = vi.hoisted(() => ({
  data: { records: [{
    agent: 'codex', session: 'synthetic', model: 'm',
    timestamp: '2025-01-01T00:00:00Z', input: Number.MAX_SAFE_INTEGER,
    output: 2, cached: 0, reasoning: 0, warnings: [],
  }] },
}));
vi.mock('../../../apps/desktop/src/usage/useUsage.js', () => ({
  useUsage: () => ({
    records: data.records, sources: [{ id: 'source', agent: 'codex', name: 'logs' }],
    warnings: [], loading: false, error: undefined,
    refresh: () => {}, addSource: () => {},
  }),
}));
import { UsageTab } from '../../../apps/desktop/src/usage/UsageTab.js';

it('does not display a rounded total when token addition exceeds safe integer precision', () => {
  const html = renderToStaticMarkup(React.createElement(UsageTab));
  expect(html).toContain('Tokeny <strong>—</strong>');
  expect(html).toContain('Súčet tokenov nemožno presne zobraziť.');
  expect(html).toContain('<span>2025-01-01</span><span>—</span>');
  expect(html).not.toContain('<meter');
});

it('retains exact independent daily counts when only the cross-day total overflows', () => {
  data.records[0]!.output = 0;
  data.records.push({ ...data.records[0]!, timestamp: '2025-01-02T00:00:00Z', input: 1 });
  try {
    const html = renderToStaticMarkup(React.createElement(UsageTab));
    expect(html).toContain('Tokeny <strong>—</strong>');
    expect(html).toContain('9.007.199.254.740.991');
    expect(html).toContain('<span>2025-01-02</span>');
    expect(html).toContain('<meter');
  } finally {
    data.records.pop();
    data.records[0]!.output = 2;
  }
});
