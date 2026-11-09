import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('../../../apps/desktop/src/usage/useUsage.js', () => ({
  useUsage: () => ({
    records: [{
      agent: 'codex', model: 'previous-model', session: 'synthetic',
      timestamp: '2025-01-01T00:00:00Z', input: 10, output: 2, cached: 0,
      reasoning: 0, warnings: [],
    }],
    sources: [{ id: 'source', agent: 'codex', name: 'synthetic' }],
    warnings: [], loading: false, error: 'Obnovenie zlyhalo',
    refresh: () => {}, addSource: () => {}, removeSource: () => {},
  }),
}));

import { UsageTab } from '../../../apps/desktop/src/usage/UsageTab.js';

it('blocks CSV export after refresh fails while showing the error and retaining prior data', () => {
  const html = renderToStaticMarkup(React.createElement(UsageTab));
  expect(html).toMatch(/<p role="alert"[^>]*>Obnovenie zlyhalo<\/p>/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Exportovať CSV<\/button>/);
  expect(html).toContain('previous-model');
  expect(html).toContain('aria-label="Odobrať z Usage: codex (synthetic)"');
});
