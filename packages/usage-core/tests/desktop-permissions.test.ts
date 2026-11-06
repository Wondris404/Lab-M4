import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('grants the close handler permission to destroy the main window', async () => {
  const capability = JSON.parse(await readFile('apps/desktop/src-tauri/capabilities/default.json', 'utf8')) as { permissions: string[] };
  expect(capability.permissions).toContain('core:window:allow-destroy');
});

it('grants the terminal and persistence permissions used by the main window', async () => {
  const capability = JSON.parse(await readFile('apps/desktop/src-tauri/capabilities/default.json', 'utf8')) as { permissions: string[] };
  for (const permission of [
    'core:event:allow-listen', 'core:event:allow-unlisten',
    'core:window:allow-close',
    'allow-spawn-powershell', 'allow-write-powershell', 'allow-resize-powershell',
    'allow-kill-powershell', 'allow-load-sessions', 'allow-save-sessions',
    'allow-agent-hook-url', 'allow-load-app-settings', 'allow-save-app-settings',
  ]) expect(capability.permissions).toContain(permission);
  expect(capability.permissions).not.toContain('core:default');
});
