// External WebDriver smoke test: no test commands or plugins are built into the app.
// Run in a disposable Windows profile with tauri-driver and a debug or installed build.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('Windows is required for this smoke test');
const installed = process.env.LAB_M4_INSTALLED_EXE;
if (installed && process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('The installed Usage smoke requires a disposable GitHub-hosted runner');
}
const binary = installed ? resolve(installed) : resolve('apps/desktop/src-tauri/target/debug/wraith.exe');
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
if (installed) {
  // Only the disposable installed app can use the runner's real profile.
  // The Node process driving WebDriver stays outside this PATH restriction.
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) env[name] = process.env[name];
  env.PATH = join(env.SystemRoot, 'System32');
}
const driverArgs = process.env.TAURI_NATIVE_DRIVER ? ['--native-driver', process.env.TAURI_NATIVE_DRIVER] : [];
const driver = spawn(driverPath, driverArgs, { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
let driverError;
driver.on('error', (error) => { driverError = error; });
let stage = 'driver startup';
driver.on('exit', (code, signal) => {
  driverError ??= new Error(`tauri-driver exited (code ${code}, signal ${signal})`);
});
const overall = setTimeout(() => {
  console.error(`WebDriver smoke timed out during ${stage}`);
  driver.kill();
  process.exit(1);
}, 240_000);
const base = 'http://127.0.0.1:4444';
let session;

async function step(label, action) {
  stage = label;
  console.log(`[webdriver] ${label}`);
  return action();
}

async function request(method, path, body, timeout = 8000) {
  const route = path.replace(/\/session\/[^/]+/, '/session/<id>');
  try {
    const response = await fetch(base + path, {
      method, signal: AbortSignal.timeout(timeout),
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok || data.value?.error) {
      throw new Error(data.value?.message ?? data.value?.error ?? `HTTP ${response.status}`);
    }
    return data.value;
  } catch (error) {
    throw new Error(`${method} ${route}: ${error.name}: ${error.message}`, { cause: error });
  }
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
  const actions = [...line].flatMap((value) => [
    { type: 'keyDown', value }, { type: 'keyUp', value },
  ]);
  await request('POST', endpoint('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions }] }, 30_000);
  await request('DELETE', endpoint('/actions'));
  // A separate action tick releases the text keyboard state before Return.
  await request('POST', endpoint('/actions'), { actions: [{ type: 'key', id: 'keyboard', actions: [
    { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' },
  ] }] });
  await request('DELETE', endpoint('/actions'));
}

async function readMarker(name) {
  try { return (await readFile(join(scratch, name), 'utf8')).replace(/^\uFEFF/, '').trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function marker(name, expected) {
  const result = await until(`PowerShell to write ${name}`, () => readMarker(name));
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
  const value = await step('launch application and attach WebView', () =>
    request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } }, 60_000));
  session = value.sessionId;
  if (!session) throw new Error('Missing WebDriver session id');
  await step('load UI', () => until('document', () =>
    request('POST', endpoint('/execute/sync'), { script: 'return document.readyState === "complete" && !!document.querySelector("#root");', args: [] })));
  await step('locate Tauri bridge', async () => {
    const available = await request('POST', endpoint('/execute/sync'), {
      script: 'return typeof window.__TAURI_INTERNALS__?.invoke === "function";', args: [],
    });
    if (!available) throw new Error('Tauri invoke bridge is unavailable');
    await request('POST', endpoint('/execute/sync'), {
      script: `window.labKeyTrace = []; for (const type of ['keydown','keyup','beforeinput','input']) document.addEventListener(type, e => { window.labKeyTrace.push({type, key:e.key, data:e.data, target:e.target?.className}); if(window.labKeyTrace.length > 512) window.labKeyTrace.shift(); }, true);`, args: [],
    });
  });
  await step('create initial terminal session', () =>
    until('initial terminal session', async () => (await elements('.session-item')).length === 1));
}
async function closeWindow() {
  await request('DELETE', endpoint('/window'), undefined, 20_000);
  try { await request('DELETE', endpoint(''), undefined, 5000); } catch { /* window close may already end the session */ }
  session = undefined;
}
function writeMarker(name, expr) {
  // Print the computed result before writing the out-of-band marker so a
  // screenshot can distinguish PowerShell execution from marker I/O failure.
  return `$labMarker="${expr}|$((Get-Date).Year)|$PID"; Write-Output $labMarker; [IO.File]::WriteAllText([IO.Path]::Combine($env:LAB_E2E_DIR,'${name}'),$labMarker)`;
}

async function verifyInstalledUsage() {
  await startSession();
  await step('scan two fixtures through the installed Usage tab', async () => {
    await click('.lab-tabs button:nth-of-type(2)');
    await until('installed Usage results', async () => {
      const result = await request('POST', endpoint('/execute/sync'), {
        script: `const usage = document.querySelector('.usage-tab');
          if (!usage) return null;
          return {
            error: usage.querySelector('[role="alert"]')?.textContent,
            partial: [...usage.querySelectorAll('[role="status"]')].some(e => e.textContent.startsWith('Orientačný odhad')),
            rows: [...usage.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent)),
          };`, args: [],
      });
      if (result?.error) throw new Error(`Installed Usage scan failed: ${result.error}`);
      if (!result?.partial || result.rows.length !== 1) return false;
      const row = result.rows[0];
      if (row[1] !== 'codex' || row[4] !== '10' || row[5] !== '4' || row[8] !== '—')
        throw new Error('Installed Usage returned unexpected token counts or pricing');
      return true;
    }, 60_000);
  });
  await step('close installed Lab-M4', closeWindow);
  console.log('Installed Usage smoke passed: bundled runtime, valid and truncated input, partial results, unknown cost');
}

async function verifyTerminal() {
  await startSession();
  await step('send ordered input to first terminal', async () => {
    await typeLine("$global:labSession='first'; $global:labOrder='A'");
    await typeLine("$global:labOrder+='B'");
    await typeLine(writeMarker('first.txt', '$global:labSession-$global:labOrder'));
  });
  const firstPid = await step('read first terminal marker', () => marker('first.txt', 'first-AB'));
  await step('create second terminal', async () => {
    await click('[aria-label="Actions menu"]');
    await click('.sidebar-menu button:nth-of-type(2)');
    await until('second session', async () => (await elements('.session-item')).length === 2);
  });
  await step('send input to second terminal', () =>
    typeLine(`$global:labSession='second'; ${writeMarker('second.txt', '$global:labSession')}`));
  const secondPid = await step('read second terminal marker', () => marker('second.txt', 'second'));
  if (firstPid === secondPid) throw new Error('Sessions unexpectedly share a PowerShell process');
  await step('verify first terminal state after switching', async () => {
    await click('.session-item', 0);
    await typeLine(writeMarker('first-again.txt', '$global:labSession-$global:labOrder'));
    await marker('first-again.txt', 'first-AB');
  });
  await step('close second terminal and wait for PowerShell exit', async () => {
    await click('.session-item', 1);
    await click('.session-item .close-btn', 1);
    await click('.confirm-modal-btn-danger');
    await until('second session closed', async () => (await elements('.session-item')).length === 1);
    await until('second PowerShell exit', async () => !isRunning(secondPid));
  });
  await step('verify first terminal after closing the second', async () => {
    await typeLine(writeMarker('after-close.txt', '$global:labSession-$global:labOrder'));
    await marker('after-close.txt', 'first-AB');
  });
  await step('close window with idle terminal', closeWindow);
  await until('first PowerShell exit', async () => !isRunning(firstPid));
  await startSession();
  await typeLine(writeMarker('relaunch.txt', 'relaunch'));
  const relaunchPid = await marker('relaunch.txt', 'relaunch');
  await step('wait for active terminal output before closing', async () => {
    await typeLine(`Write-Output 'LAB-M4-OUTPUT-0'; ${writeMarker('output-start.txt', 'output-start')}; 1..2000 | ForEach-Object { "LAB-M4-OUTPUT-$_"; Start-Sleep -Milliseconds 20 }; ${writeMarker('output-end.txt', 'output-end')}`);
    if (await marker('output-start.txt', 'output-start') !== relaunchPid) {
      throw new Error('Output was started in a different PowerShell process');
    }
  });
  await step('close window with active terminal output', async () => {
    await closeWindow();
    await until('PowerShell exit while producing output', async () => !isRunning(relaunchPid));
    if (await readMarker('output-end.txt')) throw new Error('Output completed before the window closed');
  });
  console.log('Windows WebDriver smoke passed: sessions, input ordering, Get-Date, close, relaunch and output cleanup');
}

try {
  await step('start tauri-driver', () => until('tauri-driver', async () => {
    try { await request('GET', '/status', undefined, 1000); return true; } catch { return false; }
  }));
  if (installed) await verifyInstalledUsage();
  else await verifyTerminal();
} catch (error) {
  console.error(`[webdriver] failed during ${stage}`, error);
  if (session) {
    try {
      const trace = await request('POST', endpoint('/execute/sync'), { script: 'return window.labKeyTrace;', args: [] }, 3000);
      const png = await request('GET', endpoint('/screenshot'), undefined, 3000);
      const artifacts = resolve('.lab-m4/webdriver-artifacts');
      await mkdir(artifacts, { recursive: true });
      await writeFile(join(artifacts, 'keys.json'), JSON.stringify({stage, trace}));
      await writeFile(join(artifacts, 'failure.png'), Buffer.from(png, 'base64'));
    } catch (screenshotError) {
      console.error('[webdriver] screenshot unavailable:', screenshotError.message);
    }
  }
  process.exitCode = 1;
} finally {
  if (session) { try { await request('DELETE', endpoint(''), undefined, 5000); } catch { /* retain original test failure */ } }
  clearTimeout(overall);
  driver.kill();
}
