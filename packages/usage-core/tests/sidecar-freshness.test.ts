import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
});
