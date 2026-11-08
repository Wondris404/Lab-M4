import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectAgent } from './agent-rpc.mjs';

const work = resolve('.lab-m4');
const homes = join(work, 'agent-homes');

export function agentHomeEnv(systemRoot, scratch, homeRoot) {
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, 'System32'),
    USERPROFILE: scratch, HOME: scratch, APPDATA: join(scratch, 'roaming'),
    LOCALAPPDATA: join(scratch, 'local'), CODEX_HOME: join(homeRoot, 'codex'),
    GROK_HOME: join(homeRoot, 'grok'), TMP: scratch, TEMP: scratch,
  };
}

async function executable(path) {
  if (!path || !isAbsolute(path) || !/\.exe$/i.test(path))
    throw new Error('Supply absolute paths to native Windows executables');
  return realpath(path);
}

async function probe(host, provider, exe, systemRoot, signal) {
  const scratch = await mkdtemp(join(work, 'agent-preflight-'));
  for (const name of ['roaming', 'local']) await mkdir(join(scratch, name));
  for (const name of ['codex', 'grok']) await mkdir(join(homes, name), { recursive: true });
  const env = agentHomeEnv(systemRoot, scratch, homes);
  const codex = provider === 'codex';
  const args = codex ? ['app-server'] : ['agent', '--no-leader', 'stdio'];
  signal.throwIfAborted();
  const child = spawn(host, ['15000', exe, ...args], { cwd: scratch, env, windowsHide: true });
  const agent = connectAgent(child, { jsonrpc: !codex, signal });
  let outcome;
  try {
    if (codex) {
      const init = await agent.request('initialize', {
        clientInfo: { name: 'lab_m4', title: 'Lab-M4', version: '0.2.0' },
      });
      if (init.result?.platformOs !== 'windows') throw new Error('Unexpected Codex initialization');
      agent.notify('initialized');
      const { result } = await agent.request('account/read', { refreshToken: false });
      if (typeof result?.requiresOpenaiAuth !== 'boolean')
        throw new Error('Unexpected Codex account response');
      outcome = { accountAvailable: !!result.account, requiresOpenaiAuth: result.requiresOpenaiAuth };
    } else {
      const { result } = await agent.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      if (result?.protocolVersion !== 1 || !Array.isArray(result.authMethods))
        throw new Error('Unexpected Grok ACP initialization');
      const { result: session, error } = await agent.request('session/new', { cwd: scratch, mcpServers: [] });
      if (typeof session?.sessionId !== 'string' && !Number.isSafeInteger(error?.code))
        throw new Error('Unexpected Grok session response');
      const known = new Set(['grok.com', 'cached_token', 'xai.api_key']);
      outcome = {
        protocolVersion: 1,
        authMethods: result.authMethods.map((item) => item?.id).filter((id) => known.has(id)),
        sessionAvailable: typeof session?.sessionId === 'string',
        ...(error && { errorCode: error.code }),
      };
    }
  } finally {
    const job = await agent.stop();
    if (outcome) console.log(JSON.stringify({ provider, ...outcome, job }));
  }
}

async function main([host, codex, grok, ...extra]) {
  if (process.platform !== 'win32' || !process.env.SystemRoot || extra.length || !grok)
    throw new Error('Usage: pnpm orchestrator:preflight <transport.exe> <codex.exe> <grok.exe>');
  const [transport, manager, worker] = await Promise.all([host, codex, grok].map(executable));
  await mkdir(work, { recursive: true });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Agent cancelled'));
  process.once('SIGINT', cancel);
  try {
    await probe(transport, 'codex', manager, process.env.SystemRoot, controller.signal);
    await probe(transport, 'grok-build', worker, process.env.SystemRoot, controller.signal);
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
