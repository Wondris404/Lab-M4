// Publication gate: checks current files, never prints matched secret values.
// This is a regression guard, not proof that arbitrary personal text is anonymous.
import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { decompress } from 'fzstd';
import { createHash } from 'node:crypto';

const approvedArchive = 'packages/usage-core/fixtures/synthetic/codex.jsonl.zst';
const approvedArchiveHash = 'fc60ba47c6af9aead7a1d2fe872271d63f37372b5fb9531d30ce043c0bcff36f';
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider or forge credential', /(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|(?:sk-|xai-)[A-Za-z0-9_-]{24,})/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['personal Windows home', /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<|%)[A-Za-z0-9_.-]+/],
];
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
let scanned = 0;
for (const path of [...new Set(paths)]) {
  const info = await lstat(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (info?.isSymbolicLink()) { failures.push(`${path}: unreviewed symbolic link`); continue; }
  if (!info?.isFile()) continue;
  scanned++;
  if (/(?:^|\/)(?:auth|credentials|sources|sessions)\.json$|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite3?(?:-[a-z]+)?|jsonl|csv|har|db(?:-[a-z]+)?|pem|key|log(?:\..*)?)$/i.test(path) && !path.endsWith('.env.example'))
    failures.push(`${path}: private runtime/credential filename`);
  let bytes = await readFile(path);
  if (/\.(?:zst|zip|gz|xz|7z|tar)$/i.test(path)) {
    if (path !== approvedArchive || createHash('sha256').update(bytes).digest('hex') !== approvedArchiveHash) {
      failures.push(`${path}: unreviewed archive`);
      continue;
    }
    bytes = Buffer.from(decompress(bytes));
  }
  if (bytes.includes(0)) continue; // Images/native assets are separately reviewed; do not decode arbitrary binary.
  const text = bytes.toString('utf8');
  for (const [label, pattern] of patterns) if (pattern.test(text)) failures.push(`${path}: ${label}`);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`Privacy gate passed: ${scanned} current files, reviewed synthetic archive verified. Git history is not rewritten or certified.`);
