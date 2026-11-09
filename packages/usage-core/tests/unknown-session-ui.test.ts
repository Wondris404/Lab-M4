import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { data } = vi.hoisted(() => ({
  data: { records: [
    { agent: 'grok-build', session: 'known-grok', sessionKnown: true },
    { agent: 'grok-build', session: 'known-grok', sessionKnown: true },
    { agent: 'codex', session: 'known-codex' },
    { agent: 'grok-build', session: 'synthetic-unknown', sessionKnown: false },
    { agent: 'grok-build', session: 'synthetic-unknown', sessionKnown: false },
  ].map((record) => ({
    ...record, model: 'synthetic-model', timestamp: '2025-01-01T00:00:00Z',
    input: 10, output: 2, cached: 1, reasoning: 0, warnings: [],
  })) },
}));
vi.mock('../../../apps/desktop/src/usage/useUsage.js', () => ({
  useUsage: () => ({
    records: data.records, sources: [{ id: 'source', agent: 'grok-build', name: 'logs' }],
    warnings: [], loading: false, error: undefined,
    refresh: () => {}, addSource: () => {},
  }),
}));
import { UsageTab } from '../../../apps/desktop/src/usage/UsageTab.js';
import { selectUsage } from '../../../apps/desktop/src/usage/viewModel.js';
import { usageCsv } from '../../../apps/desktop/src/usage/csv.js';

it('counts only known sessions, marks incompleteness, and retains unknown usage', () => {
  const html = renderToStaticMarkup(React.createElement(UsageTab));
  expect(html).toContain('Známe relácie <strong>2</strong>');
  expect(html).toContain('Neúplné: neznáme relácie');
  expect(html).toMatch(/<td[^>]*>Neznáma<\/td>/);
  expect(html).not.toContain('synthetic-unknown');
  expect(html).toContain('known-grok');
  expect(html).toContain('known-codex');
  expect(html).toContain('class="usage-hero" title="60">60</strong>');
  const csv = usageCsv(data.records);
  expect(csv).not.toContain('synthetic-unknown');
  expect(csv).toContain('"known-grok"');
  expect(csv).toContain('"synthetic-model";"";"10"');
});

it('does not match an unknown session to a selected known session with the same identifier', () => {
  const known = { ...data.records[0]!, session: 'same' };
  const unknown = { ...data.records[3]!, session: 'same', sessionKnown: false };
  const rows = selectUsage([known, unknown], { agent: '', model: '', day: '', session: 'same' }, 'timestamp', false);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.sessionKnown).toBe(true);
});
