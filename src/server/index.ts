import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();
app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.get('/api/summary', (c) =>
  c.json({
    records: [],
    totals: null,
  }),
);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 3001 }, (info) => {
  console.log(`API: http://127.0.0.1:${info.port}`);
});
