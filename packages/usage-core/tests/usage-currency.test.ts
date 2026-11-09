import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';

const { records } = vi.hoisted(() => ({
  records: [{
    agent: 'codex', model: 'test-model', session: 'synthetic',
    timestamp: '2025-01-01T00:00:00Z', input: 10, output: 2, cached: 1,
    reasoning: 0, costUsd: 1.25, warnings: [],
  }, {
    agent: 'codex', model: 'unknown-cost', session: 'synthetic',
    timestamp: '2025-01-02T00:00:00Z', input: 1, output: 1, cached: 0,
    reasoning: 0, warnings: [],
  }],
}));

vi.mock('../../../apps/desktop/src/usage/useUsage.js', () => ({
  useUsage: () => ({
    records, sources: [{ id: 'synthetic', agent: 'codex', name: 'logs' }],
    warnings: [], loading: false, error: undefined,
    refresh: () => {}, addSource: () => {},
  }),
}));

import { UsageTab } from '../../../apps/desktop/src/usage/UsageTab.js';

describe('known USD and unknown costs', () => {
  it('renders the USD amount and an explicitly partial sum for unknown cost', () => {
    const html = renderToStaticMarkup(React.createElement(UsageTab));
    expect(html).toContain('<th>USD</th>');
    expect(html).toMatch(/<td[^>]*>1,25<\/td>/);
    expect(html.replaceAll('\u00a0', ' ')).toContain('1,25 USD');
    expect(html).toContain('Čiastočné / NEOVERENÉ');
    expect(html).not.toContain('<th>EUR</th>');
  });

  it('exports known USD with a USD header and leaves unknown values blank', () => {
    const csv = usageCsv(records);
    expect(csv).toContain('cost_usd');
    expect(csv).toContain('"1.25"');
    expect(csv).toContain('""\r\n');
    expect(csv).not.toContain('cost_eur');
  });
});
