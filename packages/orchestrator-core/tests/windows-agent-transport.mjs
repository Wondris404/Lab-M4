import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename, resolve } from 'node:path';

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
function imagePids(image) {
  const command = `(Get-CimInstance Win32_Process -Filter \"Name='${image.replaceAll("'", "''")}'\" | Select-Object -ExpandProperty ProcessId) -join ' '`;
  return new Promise((resolvePids, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) reject(error);
      else resolvePids(String(stdout).split(/\s+/).map(Number).filter(Number.isInteger));
    });
  });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function waitFor(label, read, boundMs) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function endOwned(child, pid) {
  if (child.exitCode === null) child.kill();
  if (pid !== undefined && alive(pid)) { try { process.kill(pid); } catch { /* already reaped */ } }
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
    if (full.child.exitCode === null) full.child.kill();
  }

  const sleeperName = basename(sleeperPath);
  const interruptBefore = new Set(await imagePids(sleeperName));
  const interrupt = launch(['20000', sleeperPath, '--unrelated']);
  let interruptPid;
  const interruptStarted = Date.now();
  try {
    interruptPid = await waitFor('interrupt sleeper', async () =>
      (await imagePids(sleeperName)).find((pid) => !interruptBefore.has(pid)), 8000);
    interrupt.child.kill();
    await finish(interrupt.child, 8000);
    assert.equal(alive(interruptPid), false, 'interrupt must end the owned sleeper');
    assert.ok(Date.now() - interruptStarted < 8000);
    assert.equal(control.exitCode, null);
  } finally {
    endOwned(interrupt.child, interruptPid);
  }

  const stopBefore = new Set(await imagePids(sleeperName));
  const stopped = launch(['20000', sleeperPath, '--unrelated']);
  stopped.child.stdin.on('error', () => {});
  let stoppedPid;
  const stopStarted = Date.now();
  try {
    stoppedPid = await waitFor('STOP sleeper', async () =>
      (await imagePids(sleeperName)).find((pid) => !stopBefore.has(pid)), 8000);
    stopped.child.stdin.end();
    assert.equal(await finish(stopped.child, 8000), 0);
    assert.match(stopped.stderr(), /LAB_M4_JOB_STOP \d+ 0/);
    assert.equal(alive(stoppedPid), false, 'STOP must end the owned sleeper');
    assert.ok(Date.now() - stopStarted < 8000);
    assert.equal(control.exitCode, null);
  } finally {
    endOwned(stopped.child, stoppedPid);
  }

  const concurrentBefore = new Set(await imagePids(sleeperName));
  const first = launch(['20000', sleeperPath, '--unrelated']);
  const second = launch(['20000', sleeperPath, '--unrelated']);
  first.child.stdin.on('error', () => {});
  second.child.stdin.on('error', () => {});
  let firstPid;
  let secondPid;
  const concurrentStarted = Date.now();
  try {
    const spawned = await waitFor('two sleepers', async () => {
      const fresh = (await imagePids(sleeperName)).filter((pid) => !concurrentBefore.has(pid));
      return fresh.length >= 2 ? fresh : null;
    }, 8000);
    [firstPid, secondPid] = spawned;
    first.child.stdin.end();
    second.child.stdin.end();
    const [firstCode, secondCode] = await Promise.all([
      finish(first.child, 8000), finish(second.child, 8000),
    ]);
    assert.equal(firstCode, 0);
    assert.equal(secondCode, 0);
    assert.match(first.stderr(), /LAB_M4_JOB_STOP \d+ 0/);
    assert.match(second.stderr(), /LAB_M4_JOB_STOP \d+ 0/);
    assert.equal(alive(firstPid), false);
    assert.equal(alive(secondPid), false);
    assert.ok(Date.now() - concurrentStarted < 8000);
    assert.equal(control.exitCode, null);
  } finally {
    endOwned(first.child, firstPid);
    endOwned(second.child, secondPid);
  }

  assert.equal(control.exitCode, null);
  console.log('Native transport passed: spawn failure, deadline, EOF, backpressure, interrupt, STOP, concurrent cleanup, surviving control');
} finally {
  for (const child of owned) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}
