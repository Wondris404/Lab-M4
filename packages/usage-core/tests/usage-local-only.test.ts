import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { testTempDir } from './test-temp.js';
import { handleRequest } from '../src/service/protocol.js';

it('denies network APIs in the isolated Usage process without making a request', async () => {
  const dir = await testTempDir('usage-local-only-');
  try {
    const guard = join(dir, 'local-only.cjs');
    await build({ entryPoints: ['apps/usage-service/src/local-only.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: guard });
    const code = `
      const assert = require('node:assert/strict');
      const tests = [
        () => fetch('https://example.invalid'),
        () => new WebSocket('wss://example.invalid'),
        () => new EventSource('https://example.invalid'),
        () => require('node:http').get('http://example.invalid'),
        () => require('node:https').request('https://example.invalid'),
        () => require('node:http2').connect('https://example.invalid'),
        () => require('node:net').connect(9, '127.0.0.1'),
        () => new (require('node:net').Socket)().connect(9, '127.0.0.1'),
        () => new (require('node:net').Server)().listen(0),
        () => require('node:tls').connect(9),
        () => require('node:dgram').createSocket('udp4'),
        () => require('node:child_process').spawn('unused'),
        () => new (require('node:child_process').ChildProcess)().spawn({}),
        () => new (require('node:dgram').Socket)('udp4').send('unused', 9, '127.0.0.1'),
        () => new (require('node:worker_threads').Worker)('unused'),
        () => require('node:dns').lookup('example.invalid', () => {}),
        () => require('node:dns').promises.resolve('example.invalid'),
        () => new (require('node:dns').Resolver)().resolve4('example.invalid', () => {}),
      ];
      for (const test of tests) assert.throws(test, /Usage is local-only/);
      import('node:net').then(({connect}) => assert.throws(() => connect(9), /Usage is local-only/));
      console.log(tests.length);
    `;
    const run = spawnSync(process.execPath, ['--require', guard, '-e', code], { encoding: 'utf8', timeout: 5000, env: {} });
    expect(run.error).toBeUndefined();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('18');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('loads local-only protection before Usage parsers in both entry points', async () => {
  for (const file of ['main.ts', 'cli.ts']) {
    expect(await readFile(`apps/usage-service/src/${file}`, 'utf8')).toMatch(/^import '\.\/local-only\.js';/);
  }
  const rust = await readFile('apps/desktop/src-tauri/src/usage.rs', 'utf8');
  expect(rust).toContain('.env_clear()');
  expect(rust).toContain('.app_local_data_dir()');
  expect(rust).toContain('.stdin(Stdio::piped())');
  expect(rust).not.toMatch(/reqwest|TcpStream|UdpSocket|http_request/);
});

it('keeps the Usage frontend separate from AI tools and export limited to a local Blob', async () => {
  const result = await build({ entryPoints: ['apps/desktop/src/usage/UsageTab.tsx'], bundle: true, platform: 'browser', write: false, metafile: true, external: ['@tauri-apps/api/core'], loader: { '.css': 'empty' } });
  for (const file of Object.keys(result.metafile!.inputs)) {
    expect(file).not.toMatch(/src\/(agent|settings)\//);
  }
  for (const file of await readdir('apps/desktop/src/usage')) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = await readFile(join('apps/desktop/src/usage', file), 'utf8');
    expect(source).not.toMatch(/\b(fetch|WebSocket|EventSource|XMLHttpRequest|sendBeacon|http_request|openUrl)\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
  }
  const tab = await readFile('apps/desktop/src/usage/UsageTab.tsx', 'utf8');
  expect(tab).toContain('URL.createObjectURL(');
  expect(tab).toContain('new Blob(');
  expect(tab).toContain("link.download = 'usage.csv'");
  expect(tab).toContain('vaše skutočné údaje');
  const hook = await readFile('apps/desktop/src/usage/useUsage.ts', 'utf8');
  expect(hook).toContain("from '@tauri-apps/api/core'");
});

it('keeps credential-like sources excluded and private runtime files ignored', async () => {
  const checks = spawnSync('git', ['check-ignore', '--stdin'], { input: [
    '.lab-m4/usage/cache.sqlite', 'usage-exports/november.csv', 'exports/usage.csv',
    'agent-usage/logs/run.json', '.codex/auth.json', 'scratch/credentials.json',
    '.env.local', 'scratch/cache-v2.sqlite-wal', '_agent-tauri-dev.log.err',
  ].join('\n'), encoding: 'utf8' });
  expect(checks.status).toBe(0);
  expect(checks.stdout.trim().split('\n')).toHaveLength(9);
});

it('preserves the selected local settings accessibility fix', async () => {
  const modal = await readFile('apps/desktop/src/settings/AppSettingsModal.tsx', 'utf8');
  expect(modal).toContain('ref={dialogRef}');
  expect(modal).toContain('previous.focus()');
  expect(modal).toContain('event.key === "Escape"');
  expect(modal).toContain('event.shiftKey');
  expect(modal).toContain('last.focus()');
  expect(modal).toContain('first.focus()');
});

it('does not retain raw messages or credential fields in scan output or the local cache', async () => {
  const dir = await testTempDir('privacy-records-');
  try {
    const source = join(dir, 'session.jsonl');
    const cachePath = join(dir, 'cache.sqlite');
    const marker = 'SYNTHETIC-PRIVATE-MESSAGE-NOT-A-CREDENTIAL';
    await writeFile(source, [
      { type: 'session_meta', payload: { id: 'synthetic-session', api_key: marker } },
      { type: 'turn_context', payload: { model: 'model-test' } },
      { type: 'response_item', payload: { role: 'user', content: marker } },
      { type: 'event_msg', timestamp: '2025-01-01T00:00:00Z', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 10, output_tokens: 4 },
        last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_output_tokens: 1 },
      } } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const output = await handleRequest({ version: 1, requestId: 'privacy', method: 'scan', params: { agent: 'codex', path: source, cachePath } });
    expect(output.result.records).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain(marker);
    expect(JSON.stringify(output)).not.toContain('synthetic-session');
    expect((await readFile(cachePath)).includes(Buffer.from(marker))).toBe(false);
    expect((await readFile(cachePath)).includes(Buffer.from('synthetic-session'))).toBe(false);
    expect(await readFile(source, 'utf8')).toContain(marker);
    for (const name of ['auth.json', 'credentials.json', 'secret.jsonl']) {
      await writeFile(join(dir, name), marker);
      await expect(handleRequest({ version: 1, requestId: 'excluded', method: 'scan', params: { agent: 'codex', path: join(dir, name), cachePath } })).rejects.toThrow('Nepovolená cesta');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
