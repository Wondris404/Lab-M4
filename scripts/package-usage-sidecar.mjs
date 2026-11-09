import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'apps/desktop/usage-service');
const rootRequire = createRequire(join(root, 'package.json'));
const sqliteEntry = rootRequire.resolve('sqlite3');
const sqliteRoot = await realpath(join(dirname(sqliteEntry), '..'));
const sqliteRequire = createRequire(join(sqliteRoot, 'package.json'));
const bindingsRoot = dirname(sqliteRequire.resolve('bindings/package.json'));
const bindingsRequire = createRequire(join(bindingsRoot, 'package.json'));
const uriRoot = dirname(bindingsRequire.resolve('file-uri-to-path/package.json'));
const usageRequire = createRequire(join(root, 'packages/usage-core/package.json'));
const xxhashRoot = await realpath(join(dirname(usageRequire.resolve('xxhash-wasm')), '..'));
const fzstdRoot = await realpath(join(dirname(usageRequire.resolve('fzstd')), '..'));
const executable = await realpath(process.execPath);
const distribution = process.platform === 'win32' ? dirname(executable) : resolve(dirname(executable), '..');
const nodeLicense = await readFile(join(distribution, 'LICENSE')).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  throw new Error(`Node ${process.version} LICENSE is missing. Run packaging with Node from the official release archive.`);
});
const desktop = join(root, 'apps/desktop');
if (await realpath(desktop) !== desktop) throw new Error('Desktop staging parent resolves outside its expected path');
const previous = await lstat(stage).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
if (previous && !previous.isDirectory()) throw new Error('Invalid sidecar staging directory');
// This fixed, verified directory contains only generated artifacts.
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'node_modules'), { recursive: true });
await build({ entryPoints: [join(root, 'apps/usage-service/src/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['sqlite3'], outfile: join(stage, 'main.cjs') });
if (process.platform === 'win32') {
  const orchestrator = join(root, 'packages/orchestrator-core');
  await build({ entryPoints: [join(orchestrator, 'src/desktop-bridge.mjs')], bundle: true, platform: 'node', format: 'cjs', outfile: join(stage, 'orchestration.cjs') });
  execFileSync('rustc', ['--edition', '2021', '-D', 'warnings', '-O', join(orchestrator, 'native/agent_transport.rs'), '-o', join(stage, 'agent_transport.exe')], { stdio: 'inherit', windowsHide: true });
}
for (const [name, source] of [['sqlite3', sqliteRoot], ['bindings', bindingsRoot], ['file-uri-to-path', uriRoot]]) {
  await cp(source, join(stage, 'node_modules', name), { recursive: true, dereference: true });
}
await cp(executable, join(stage, process.platform === 'win32' ? 'node.exe' : 'node'));
await mkdir(join(stage, 'licenses'), { recursive: true });
await writeFile(join(stage, 'licenses/node-LICENSE'), nodeLicense);
await cp(join(fzstdRoot, 'LICENSE'), join(stage, 'licenses/fzstd-LICENSE'));
await cp(join(xxhashRoot, 'LICENSE.md'), join(stage, 'licenses/xxhash-wasm-LICENSE.md'));
await writeFile(join(stage, 'runtime.json'), JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
}));

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
