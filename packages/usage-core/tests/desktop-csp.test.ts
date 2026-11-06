import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('permits the actual font hosts without relaxing scripts or IPC policy', async () => {
  const config = JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8')) as {
    app: { security: { csp: string } };
  };
  const directives = new Map(config.app.security.csp.split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name, values];
  }));
  expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']);
  expect(directives.get('font-src')).toEqual(["'self'", 'https://fonts.gstatic.com', 'data:']);
  expect(directives.get('script-src')).toEqual(["'self'"]);
  expect(directives.get('connect-src')).toEqual(["'self'", 'ipc:', 'http://ipc.localhost']);
  expect(directives.get('object-src')).toEqual(["'none'"]);
});
