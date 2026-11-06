import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('does not invoke or register automatic agent hook installation', async () => {
  const app = await readFile('apps/desktop/src/App.tsx', 'utf8');
  const backend = await readFile('apps/desktop/src-tauri/src/lib.rs', 'utf8');
  const commands = backend.split('.invoke_handler(tauri::generate_handler![')[1]?.split('])')[0];
  expect(commands).toBeDefined();
  expect(commands).not.toContain('ensure_agent_hooks');
  expect(app).not.toMatch(/invoke(?:<[^>]*>)?\s*\(\s*["']ensure_agent_hooks["']/);
});
