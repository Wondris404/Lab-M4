import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps every distributed desktop version at 1.1.0', async () => {
  for (const file of ['apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe('1.1.0');
  }
  const cargo = await readFile('apps/desktop/src-tauri/Cargo.toml', 'utf8');
  expect(cargo).toMatch(/\[package\][\s\S]*?version = "1\.1\.0"/);
  const lock = await readFile('apps/desktop/src-tauri/Cargo.lock', 'utf8');
  expect(lock).toContain('name = "wraith"\nversion = "1.1.0"');
  expect(JSON.parse(await readFile('package.json', 'utf8')).private).toBe(true);
});
