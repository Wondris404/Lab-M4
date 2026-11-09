import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
const temp = resolve('.lab-m4/test-tmp');
mkdirSync(temp, { recursive: true });
process.env.TEMP = temp; process.env.TMP = temp; process.env.TMPDIR = temp;
export default defineConfig({ test: { include: ['packages/usage-core/tests/**/*.test.ts', 'apps/desktop/tests/**/*.test.ts'] } });
