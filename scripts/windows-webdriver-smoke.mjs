// External WebDriver smoke test: no test commands or plugins are built into the app.
// Run only in a disposable Windows profile, with a debug build and tauri-driver.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('Windows is required for this smoke test');
const binary = resolve('apps/desktop/src-tauri/target/debug/wraith.exe');
const driverPath = process.env.TAURI_DRIVER;
if (!driverPath) throw new Error('TAURI_DRIVER must point to the installed tauri-driver executable');
const scratch = await mkdtemp(join(tmpdir(), 'lab-m4-webdriver-'));
for (const name of ['appdata', 'local', 'profile']) await mkdir(join(scratch, name));
const env = {};
for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'PATH', 'PATHEXT', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
  if (process.env[name]) env[name] = process.env[name];
}
Object.assign(env, {
  USERPROFILE: join(scratch, 'profile'), APPDATA: join(scratch, 'appdata'),
  LOCALAPPDATA: join(scratch, 'local'), TEMP: scratch, TMP: scratch, LAB_E2E_DIR: scratch,
});
const driver = spawn(driverPath, [], { env, stdio: 'ignore', windowsHide: true });
let driverError;
driver.on('error', (error) => { driverError = error; });
const overall = setTimeout(() => { console.error('WebDriver smoke timed out'); driver.kill(); process.exit(1); }, 240_000);
const base = 'http://127.0.0.1:4444';
let session;

async function request(method, path, body, timeout = 8000) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(timeout),
    ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw new Error(`WebDriver ${method} ${path.replace(/\/session\/[^/]+/, '/session/<id>')} failed: ${data.value?.error ?? response.status}`);
  return data.value;
}
async function until(label, condition, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (driverError) throw driverError;
    const result = await condition();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const endpoint = (path) => `/session/${session}${path}`;
async function elements(selector) {
  return request('POST', endpoint('/elements'), { using: 'css selector', value: selector });
}
const elementId = (element) => element['element-6066-11e4-a52e-4f735466cecf'];
async function click(selector, index = 0) {
  const element = await until(selector, async () => (await elements(selector))[index]);
  await request('POST', endpoint(`/element/${elementId(element)}/click`), {});
}
async function typeLine(line) {
  await click('.session-view.active .xterm-screen');
  const actions = [...line, '\uE007'].flatMap((value) => [
    { type: 'keyDown', value }, { type: 'keyUp', value },
  ]);
  await request('POST', endpoint('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions }] }, 30_000);
  await request('DELETE', endpoint('/actions'));
}
async function readMarker(name) {
  try { return (await readFile(join(scratch, name), 'utf8')).replace(/^\uFEFF/, '').trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function marker(name, expected) {
  const result = await until(name, async () => {
    const value = await readMarker(name);
    return value.startsWith(expected + '|') ? value : '';
  });
  const [value, year, pid] = result.split('|');
  if (value !== expected || Number(year) < 2020 || Number(year) > 2200 || !/^\d+$/.test(pid))
    throw new Error(`Unexpected PowerShell result for ${name}`);
  return Number(pid);
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function startSession() {
  const value = await request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } }, 60_000);
  session = value.sessionId;
  if (!session) throw new Error('Missing WebDriver session id');
  await until('initial terminal session', async () => (await elements('.session-item')).length === 1);
}
async function closeWindow() {
  await request('DELETE', endpoint('/window'), undefined, 20_000);
  try { await request('DELETE', endpoint(''), undefined, 5000); } catch { /* window close may already end the session */ }
  session = undefined;
}
function writeMarker(name, expr) {
  return `"${expr}|$((Get-Date).Year)|$PID" | Set-Content -Encoding utf8 -LiteralPath (Join-Path $env:LAB_E2E_DIR '${name}')`;
}

try {
  await until('tauri-driver', async () => {
    try { await request('GET', '/status', undefined, 1000); return true; } catch { return false; }
  });
  await startSession();
  await typeLine(`$global:labSession='first'; $global:labOrder='A'; $global:labOrder+='B'; ${writeMarker('first.txt', '$global:labSession-$global:labOrder')}`);
  const firstPid = await marker('first.txt', 'first-AB');
  await click('[aria-label="Actions menu"]');
  await click('.sidebar-menu button:nth-of-type(2)');
  await until('second session', async () => (await elements('.session-item')).length === 2);
  await typeLine(`$global:labSession='second'; ${writeMarker('second.txt', '$global:labSession')}`);
  const secondPid = await marker('second.txt', 'second');
  if (firstPid === secondPid) throw new Error('Sessions unexpectedly share a PowerShell process');
  await click('.session-item', 0);
  await typeLine(writeMarker('first-again.txt', '$global:labSession-$global:labOrder'));
  await marker('first-again.txt', 'first-AB');
  await click('.session-item', 1);
  await click('.session-item .close-btn', 1);
  await click('.confirm-modal-btn-danger');
  await until('second session closed', async () => (await elements('.session-item')).length === 1);
  await until('second PowerShell exit', async () => !isRunning(secondPid));
  await typeLine(writeMarker('after-close.txt', '$global:labSession-$global:labOrder'));
  await marker('after-close.txt', 'first-AB');
  await closeWindow();
  await until('first PowerShell exit', async () => !isRunning(firstPid));
  await startSession();
  await typeLine(writeMarker('relaunch.txt', 'relaunch'));
  const relaunchPid = await marker('relaunch.txt', 'relaunch');
  await typeLine('1..100000 | ForEach-Object { "LAB-M4-OUTPUT-$_" }');
  await closeWindow();
  await until('PowerShell exit while producing output', async () => !isRunning(relaunchPid));
  console.log('Windows WebDriver smoke passed: sessions, input ordering, Get-Date, close, relaunch and output cleanup');
} finally {
  if (session) { try { await request('DELETE', endpoint(''), undefined, 5000); } catch { /* retain original test failure */ } }
  clearTimeout(overall);
  driver.kill();
}
