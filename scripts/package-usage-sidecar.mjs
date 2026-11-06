import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'apps/desktop/usage-service');
// This directory contains only generated sidecar artifacts, never user data.
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'node_modules'), { recursive: true });
await build({ entryPoints: [join(root, 'apps/usage-service/src/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['sqlite3'], outfile: join(stage, 'main.cjs') });
const rootRequire = createRequire(join(root, 'package.json'));
const sqliteEntry = rootRequire.resolve('sqlite3');
const sqliteRoot = await realpath(join(dirname(sqliteEntry), '..'));
const sqliteRequire = createRequire(join(sqliteRoot, 'package.json'));
const bindingsRoot = dirname(sqliteRequire.resolve('bindings/package.json'));
const bindingsRequire = createRequire(join(bindingsRoot, 'package.json'));
const uriRoot = dirname(bindingsRequire.resolve('file-uri-to-path/package.json'));
for (const [name, source] of [['sqlite3', sqliteRoot], ['bindings', bindingsRoot], ['file-uri-to-path', uriRoot]]) {
  await cp(source, join(stage, 'node_modules', name), { recursive: true, dereference: true });
}
await cp(process.execPath, join(stage, process.platform === 'win32' ? 'node.exe' : 'node'));
// The bundled WebAssembly checksum implementation is MIT licensed. Keep its
// license alongside the sidecar even though esbuild inlines the module.
const usageRequire = createRequire(join(root, 'packages/usage-core/package.json'));
const xxhashRoot = await realpath(join(dirname(usageRequire.resolve('xxhash-wasm')), '..'));
await mkdir(join(stage, 'licenses'), { recursive: true });
await cp(join(xxhashRoot, 'LICENSE.md'), join(stage, 'licenses/xxhash-wasm-LICENSE.md'));

// Embed an inventory of generated resources in the desktop binary. The runtime
// verifies it before launch; no agent paths or personal files are included.
const inventory = {};
async function record(dir, relative = '') {
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    const full = join(dir, item.name);
    if (item.isDirectory()) await record(full, name);
    else if (item.isFile()) inventory[name] = createHash('sha256').update(await readFile(full)).digest('hex');
    else throw new Error('Unexpected sidecar artifact');
  }
}
await record(stage);
await writeFile(join(stage, 'manifest.json'), JSON.stringify(inventory));
