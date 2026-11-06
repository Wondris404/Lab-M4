import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.lab-m4', 'usage-cli');
const require = createRequire(join(root, 'package.json'));
const compiler = require.resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [
  compiler, '--target', 'es2022', '--module', 'nodenext',
  '--moduleResolution', 'nodenext', '--skipLibCheck', '--esModuleInterop',
  '--rootDir', root, '--outDir', output, join(root, 'apps/usage-service/src/cli.ts'),
], { cwd: root, stdio: 'inherit' });
if (build.error || build.status !== 0) {
  process.stderr.write('Kompilácia Usage CLI zlyhala.\n');
  process.exitCode = build.status || 1;
} else {
  const run = spawnSync(process.execPath,
    [join(output, 'apps/usage-service/src/cli.js'), ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit' });
  if (run.error) process.stderr.write('Spustenie Usage CLI zlyhalo.\n');
  process.exitCode = run.status ?? 1;
}
