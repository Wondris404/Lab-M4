import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { connectAgent } from './agent-rpc.mjs';
import { createUsageLedger, recordCodexUsage } from './usage-ledger.mjs';

const turnTimeoutMs = 180_000;
const maxTextBytes = 192 * 1024;

async function nativeExecutable(path, expected) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path).toLowerCase() !== expected)
    throw new Error(`Supply an absolute path to ${expected}`);
  return realpath(path);
}

function providerArgs({ provider, model }) {
  if (provider === 'codex') return [
    'app-server', '--stdio', '--disable', 'shell_tool', '--disable', 'multi_agent',
    '--disable', 'multi_agent_v2', '--disable', 'apps', '--disable', 'hooks',
    '--disable', 'plugins', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  ];
  if (provider === 'opencode') return ['acp', '--pure'];
  return [
    '--tools', '', '--disable-web-search', '--no-subagents', '--permission-mode', 'dontAsk',
    '--deny', 'Bash', '--deny', 'Edit', '--deny', 'Read', '--deny', 'Grep',
    '--deny', 'MCPTool', 'agent', '--no-leader',
    ...(model ? ['-m', model] : []), 'stdio',
  ];
}

function providerEnvironment(provider, executable, scratch) {
  const names = ['SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME'];
  const providerNames = {
    codex: ['CODEX_HOME', 'OPENAI_API_KEY'],
    grok: ['GROK_HOME', 'XAI_API_KEY'],
    opencode: ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB', 'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY',
      'XAI_API_KEY', 'OPENCODE_API_KEY'],
  };
  names.push(...providerNames[provider]);
  const env = Object.fromEntries(names.flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : []));
  return {
    ...env,
    PATH: `${dirname(executable)};${join(env.SystemRoot, 'System32')}`,
    TMP: scratch,
    TEMP: scratch,
    ...(provider === 'opencode' && {
      XDG_CONFIG_HOME: join(scratch, 'config'), OPENCODE_CONFIG_DIR: join(scratch, 'config'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_PERMISSION: '{"*":"deny"}',
      OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"deny"},"share":"disabled","autoupdate":false,"mcp":{}}',
    }),
  };
}

function extractResult(reply, provider, method) {
  if (reply.error || !reply.result || typeof reply.result !== 'object') {
    const code = Number.isSafeInteger(reply.error?.code) ? ` (${reply.error.code})` : '';
    const message = JSON.stringify(reply.error ?? {}).slice(0, 4096);
    const category = /\b(unauthorized|authentication|credentials|invalid token|not signed in|401|403)\b/i.test(message) ? ': authentication failed'
      : /\b(rate limit|quota|429)\b/i.test(message) ? ': provider limit reached'
      : /\b(connection|network|TLS|DNS)\b/i.test(message) ? ': connection failed'
      : /\b(unknown model|invalid model|unsupported model|model not found)\b/i.test(message) ? ': model unavailable'
      : '';
    throw new Error(`${provider} rejected ${method}${code}${category}`);
  }
  return reply.result;
}

function boundedText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxTextBytes)
    throw new Error('Provider text exceeds the supported size');
  return text;
}

async function codexTurn(request, events, prompt, model, scratch, signal) {
  await request('initialize', {
    clientInfo: { name: 'lab_m4', title: 'Lab-M4', version: '1.2' },
  });
  request.notify('initialized');
  const settings = await request('thread/start', {
    cwd: scratch, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
    ...(model && { model }),
    developerInstructions: 'Return only the requested text. Do not use any tools or access local files.',
  });
  const threadId = settings.thread?.id;
  if (typeof threadId !== 'string' || settings.thread.ephemeral !== true ||
      settings.sandbox?.type !== 'readOnly' || settings.sandbox.networkAccess !== false ||
      settings.approvalPolicy !== 'never') {
    throw new Error('Codex did not confirm the orchestration client policy');
  }
  const { turn } = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
  });
  if (typeof turn?.id !== 'string') throw new Error('Codex did not start a turn');
  const terminal = await events.waitForCompletion(threadId, turn.id, signal);
  if (terminal.status !== 'completed') throw new Error('Codex did not complete the turn');
  return {
    text: events.answer(threadId, turn.id), tokens: events.tokens(threadId),
    model: typeof settings.model === 'string' ? settings.model : model ?? null,
  };
}

async function acpTurn(provider, request, events, prompt, model, scratch) {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'lab_m4', title: 'Lab-M4', version: '1.2' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (init.protocolVersion !== 1 || !Array.isArray(init.authMethods)) {
    throw new Error(`Unsupported ${provider} ACP version`);
  }
  if (provider === 'grok') {
    const supported = new Set(init.authMethods.map(({ id }) => id));
    const available = new Set([
      ...(process.env.XAI_API_KEY && supported.has('xai.api_key') ? ['xai.api_key'] : []),
      ...(supported.has('cached_token') ? ['cached_token'] : []),
    ]);
    const preferred = init._meta?.defaultAuthMethodId;
    const methodId = available.has(preferred) ? preferred : available.values().next().value;
    if (!methodId) throw new Error('Grok requires an existing login or XAI_API_KEY');
    await request('authenticate', { methodId, _meta: { headless: true } });
  }
  const { sessionId, models, configOptions } = await request('session/new', { cwd: scratch, mcpServers: [] });
  if (typeof sessionId !== 'string') throw new Error(`${provider} did not create a session`);
  const setting = configOptions?.find((item) => item.category === 'model');
  let selected = setting?.currentValue ?? models?.currentModelId;
  if (model && selected !== model) {
    if (setting?.id) {
      const changed = await request('session/set_config_option', { sessionId, configId: setting.id, value: model });
      selected = changed.configOptions?.find((item) => item.id === setting.id)?.currentValue;
    } else if (models?.availableModels?.some(({ modelId }) => modelId === model)) {
      await request('session/set_model', { sessionId, modelId: model });
      selected = model;
    }
    if (selected !== model) throw new Error(`${provider} did not confirm the requested model`);
  }
  const result = await request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: prompt }],
  });
  if (result.stopReason !== 'end_turn') throw new Error(`${provider} did not complete the turn`);
  const total = result.usage?.totalTokens;
  return {
    text: events.answer(sessionId), tokens: Number.isSafeInteger(total) && total >= 0 ? total : null,
    model: typeof selected === 'string' ? selected : null,
    ...(provider === 'opencode' && events.acpUsage(sessionId)),
  };
}

function collectEvents(signal) {
  const usage = createUsageLedger();
  const unknownUsage = new Set();
  const answers = new Map();
  const completed = new Map();
  const acpUsage = new Map();
  let wake;
  const abort = () => wake?.();
  signal.addEventListener('abort', abort, { once: true });
  const id = (thread, turn) => JSON.stringify([thread, turn]);
  return {
    dispose() { signal.removeEventListener('abort', abort); },
    receive({ method, params }) {
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
        const key = id(params.threadId, params.turnId);
        const previous = answers.get(key);
        if (!previous?.final || params.item.phase === 'final_answer') {
          answers.set(key, { text: boundedText(params.item.text), final: params.item.phase === 'final_answer' });
        }
      } else if (method === 'turn/completed' && params?.turn) {
        completed.set(id(params.threadId, params.turn.id), params.turn);
        wake?.();
      } else if (method === 'session/update' && params?.update?.sessionUpdate === 'agent_message_chunk') {
        const key = id(params.sessionId);
        const text = (answers.get(key)?.text ?? '') + (params.update.content?.text ?? '');
        answers.set(key, { text: boundedText(text) });
      } else if (method === 'session/update' && params?.update?.sessionUpdate === 'usage_update') {
        const { size, cost } = params.update;
        acpUsage.set(params.sessionId, {
          contextLimit: Number.isSafeInteger(size) && size > 0 ? size : null,
          estimatedUsd: cost?.currency === 'USD' && typeof cost.amount === 'number' &&
            Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : null,
        });
      } else if (method === 'thread/tokenUsage/updated') {
        try { recordCodexUsage(usage, { method, params }); }
        catch { unknownUsage.add(params?.threadId); }
      }
    },
    async waitForCompletion(thread, turn, abortSignal) {
      const key = id(thread, turn);
      while (!completed.has(key)) {
        abortSignal.throwIfAborted();
        await new Promise((resolve) => { wake = resolve; });
      }
      wake = undefined;
      return completed.get(key);
    },
    answer(thread, turn) { return answers.get(id(thread, turn))?.text.trim() ?? ''; },
    tokens(thread) {
      return !unknownUsage.has(thread) && Object.hasOwn(usage.threads, thread)
        ? usage.threads[thread].totalTokens : null;
    },
    acpUsage(sessionId) { return acpUsage.get(sessionId); },
  };
}

/** A live text turn in its own native job. Only the caller's explicit prompt is passed. */
export async function runProviderTurn({ transport, provider, executable, model, prompt, signal, onStopped }) {
  if (process.platform !== 'win32' || !process.env.SystemRoot)
    throw new Error('Live agent transport requires Windows');
  const executables = { codex: 'codex.exe', grok: 'grok.exe', opencode: 'opencode.exe' };
  if (!Object.hasOwn(executables, provider))
    throw new Error('Unsupported provider');
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9_.:/#-]{1,128}$/.test(model)))
    throw new Error('Invalid model identifier');
  if (!boundedText(prompt).trim()) throw new Error('Missing prompt');
  const host = await nativeExecutable(transport, 'agent_transport.exe');
  const agentExe = await nativeExecutable(executable, executables[provider]);
  const timeout = AbortSignal.timeout(turnTimeoutMs);
  const runSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  runSignal.throwIfAborted();
  const scratch = await mkdtemp(join(tmpdir(), 'lab-m4-live-'));
  const events = collectEvents(runSignal);
  let connection;
  try {
    if (provider === 'opencode') await mkdir(join(scratch, 'config'));
    runSignal.throwIfAborted();
    const child = spawn(host, [String(turnTimeoutMs + 8000), agentExe, ...providerArgs({ provider, model })], {
      cwd: scratch, windowsHide: true, env: providerEnvironment(provider, agentExe, scratch),
    });
    connection = connectAgent(child, {
      jsonrpc: provider !== 'codex', signal: runSignal, onNotification: events.receive,
    });
    const request = async (method, params) => {
      let reply;
      try { reply = await connection.request(method, params); }
      catch (error) { throw new Error(`${provider} ${method}: ${error.message}`); }
      return extractResult(reply, provider, method);
    };
    request.notify = connection.notify;
    const result = await Promise.race([
      provider === 'codex'
        ? codexTurn(request, events, prompt, model, scratch, runSignal)
        : acpTurn(provider, request, events, prompt, model, scratch),
      connection.closed.then(() => { throw new Error(`${provider} closed its transport`); }),
    ]);
    if (!result.text) throw new Error('Provider returned no text');
    return { ...result, provider, cost: null, limits: null };
  } finally {
    events.dispose();
    try {
      if (connection) {
        const job = await connection.stop();
        onStopped?.(job);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
