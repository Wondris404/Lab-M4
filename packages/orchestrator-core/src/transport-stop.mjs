import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function stopConfirmed(code, diagnostics) {
  if (code !== 5 || !/^LAB_M4_RESULT stop\r?$/m.test(diagnostics)) return null;
  const counts = /^LAB_M4_JOB_STOP (\d+) (\d+)\r?$/m.exec(diagnostics);
  if (!counts || counts[2] !== '0') return null;
  return { before: Number(counts[1]), after: 0, code: 5 };
}

export async function stopShippedTransport(child, boundMs = 8000) {
  if (!child?.stdin || !child.stderr) throw new Error('STOP requires a live shipped transport process');
  if (resolve(child.spawnfile) === resolve(process.execPath)) {
    throw new Error('STOP cannot be confirmed by a Node peer');
  }
  let diagnostics = '';
  const onData = (chunk) => { diagnostics = (diagnostics + chunk).slice(-1024); };
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  child.stdin.write('LAB_M4_STOP\n');
  child.stdin.end();
  const timer = new AbortController();
  const code = await Promise.race([
    once(child, 'close').then(([value]) => value),
    delay(boundMs, undefined, { signal: timer.signal, ref: false }).then(() => undefined),
  ]);
  timer.abort();
  child.stderr.off('data', onData);
  if (code === undefined) {
    child.kill();
    throw new Error('Agent supervisor did not confirm STOP');
  }
  const confirmed = stopConfirmed(code, diagnostics);
  if (!confirmed) throw new Error('Agent job cleanup was not confirmed');
  return confirmed;
}
