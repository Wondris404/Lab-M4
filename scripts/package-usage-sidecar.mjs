import { cp, mkdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'apps/desktop/usage-service');
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
