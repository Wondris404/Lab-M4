import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

/** Tests run from the repository and keep their synthetic data in its ignored cache. */
export async function testTempDir(prefix: string): Promise<string> {
  const root = join(process.cwd(), '.lab-m4');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
