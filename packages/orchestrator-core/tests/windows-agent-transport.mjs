import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

const [transport, sleeper] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(transport && sleeper);
const transportPath = resolve(transport);
const sleeperPath = resolve(sleeper);
const owned = [];

function track(child) {
  owned.push(child);
  return child;
}

function launch(args) {
  const child = track(spawn(transportPath, args, { windowsHide: true }));
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-512); });
  return { child, stderr: () => stderr };
}

async function finish(child, boundMs) {
  const timer = setTimeout(() => child.kill(), boundMs);
  try {
    const [code] = await once(child, 'close');
    return code;
  } finally {
    clearTimeout(timer);
  }
}

const control = track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true }));
try {
  const missing = launch(['500', 'C:\\Lab-M4\\missing-agent.exe']);
  missing.child.stdin.end();
  assert.equal(await finish(missing.child, 8000), 1);
  assert.match(missing.stderr(), /LAB_M4_JOB_FAILED/);

  const deadline = launch(['250', sleeperPath, '--unrelated']);
  const started = Date.now();
  assert.equal(await finish(deadline.child, 8000), 124);
  assert.ok(Date.now() - started < 8000, 'the owned job must end inside the test bound');
  const counts = /^LAB_M4_JOB_STOP (\d+) 0\r?$/m.exec(deadline.stderr());
  assert.ok(counts, deadline.stderr());
  assert.ok(Number(counts[1]) >= 1, 'the job had an owned process before STOP');
  assert.equal(control.exitCode, null, 'the independent control process must survive');

  const eof = launch(['2000', process.execPath, '-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"]);
  eof.child.stdin.end();
  assert.equal(await finish(eof.child, 8000), 0);

  const full = launch(['5000', sleeperPath, '--unrelated']);
  full.child.stdin.on('error', () => {});
  const watchdog = setTimeout(() => full.child.kill(), 8000);
  try {
    for (let i = 0; i < 64 && full.child.exitCode === null; i += 1) {
      full.child.stdin.write(Buffer.alloc(8192, 66));
    }
    assert.equal(await finish(full.child, 8000), 4);
    assert.match(full.stderr(), /LAB_M4_JOB_STOP \d+ 0/);
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(control.exitCode, null);
  console.log('Native transport passed: spawn failure, deadline, EOF, backpressure, surviving control');
} finally {
  for (const child of owned) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}
