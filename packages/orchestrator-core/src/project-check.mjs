import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { stopConfirmed } from './transport-stop.mjs';

export function validateCheck(check) {
  if (!check || typeof check.executable !== 'string' || !isAbsolute(check.executable) ||
      !/\.exe$/i.test(check.executable) || !Array.isArray(check.args) || check.args.length > 32 ||
      check.args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))) {
    throw new Error('Specify the absolute test executable and up to 32 arguments');
  }
  return Object.freeze({ executable: check.executable, args: Object.freeze([...check.args]) });
}

export async function runProjectCheck({ transport, check, worktree, signal }) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || typeof transport !== 'string' || !isAbsolute(transport) ||
      basename(transport).toLowerCase() !== 'agent_transport.exe') throw new Error('Tests require the Windows transport');
  const host = await realpath(transport);
  const executable = await realpath(check.executable);
  signal?.throwIfAborted();
  const child = spawn(host, ['--check', '120000', executable, ...check.args], {
    cwd: worktree, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-256); });
  child.stdin.on('error', () => {});
  const stop = () => { child.stdin.end('LAB_M4_STOP\n'); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const [code] = await once(child, 'close');
    const cleanup = /^LAB_M4_JOB_STOP (\d+) 0\r?$/m.exec(diagnostics);
    const exit = /^LAB_M4_CHECK_EXIT (\d+)\r?$/m.exec(diagnostics);
    const cancelled = stopConfirmed(code, diagnostics);
    if (cancelled) return { status: 'cancelled', cleanup: { before: cancelled.before, after: 0 } };
    if (code === 6 && exit && cleanup) {
      return { status: Number(exit[1]), cleanup: { before: Number(cleanup[1]), after: 0 } };
    }
    if (code === 124 && cleanup) return { status: 'timeout', cleanup: { before: Number(cleanup[1]), after: 0 } };
    throw new Error('Test executable did not report a verified exit');
  } finally {
    signal?.removeEventListener('abort', stop);
    child.stdin.destroy();
  }
}
