import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('tests the sidecar built from the current tracked source', async () => {
  const output = resolve('apps/desktop/usage-service/main.cjs');
  const fresh = await build({
    entryPoints: [resolve('apps/usage-service/src/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['sqlite3'],
    outfile: output,
    write: false,
  });
  expect(await readFile(output)).toEqual(Buffer.from(fresh.outputFiles[0]!.contents));
  const require = createRequire(resolve('packages/usage-core/package.json'));
  const originalLicense = resolve(dirname(require.resolve('xxhash-wasm')), '../LICENSE.md');
  expect(await readFile(resolve('apps/desktop/usage-service/licenses/xxhash-wasm-LICENSE.md')))
    .toEqual(await readFile(originalLicense));
});
