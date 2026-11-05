import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { summaryFromFile } from './summary.js';

const app = new Hono();
app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.get('/api/summary', async (c) => {
  try {
    const summary = await summaryFromFile('config/settings.json');
    return c.json(summary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return c.json({
        recordCount: 0,
        totals: null,
        warnings: {},
        agents: {},
        errors: {},
      });
    return c.json({ error: 'Neplatné nastavenia.' }, 400);
  }
});
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3001 }, (info) =>
  console.log(`API: http://127.0.0.1:${info.port}`),
);
