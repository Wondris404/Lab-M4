import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { stopConfirmed } from './transport-stop.mjs';

const frameLimit = 1024 * 1024;
const outputLimit = 8 * frameLimit;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** One request at a time over a Windows supervisor's stdio. */
export function connectAgent(child, { jsonrpc, signal, onNotification = () => {} }) {
  let pending;
  let next = 1;
  let failure;
  let stopping;
  let bytes = 0;
  let size = 0;
  let frame = [];
  let diagnostics = '';
  const closed = once(child, 'close').then(([code]) => code, () => null);

  function settle(error, reply) {
    const request = pending;
    pending = undefined;
    if (error) request?.reject(error);
    else request?.resolve(reply);
  }

  function fail(error) {
    failure ??= error;
    settle(failure);
    void stop().catch(() => {});
  }

  function write(message) {
    if (stopping || failure || child.stdin.destroyed) throw failure ?? new Error('Agent is stopped');
    const line = JSON.stringify(jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n';
    if (Buffer.byteLength(line) > frameLimit) throw new Error('Agent input frame exceeds its limit');
    child.stdin.write(line);
  }

  function dispatch(line) {
    const message = JSON.parse(utf8.decode(line));
    if (!message || typeof message !== 'object' || Array.isArray(message))
      throw new Error('Invalid agent message');
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // No provider request, including permissions, is granted by the transport.
        write({ id: message.id, error: { code: -32601, message: 'Provider request unsupported' } });
      } else {
        onNotification(message);
      }
      return;
    }
    if (!pending || message.id !== pending.id ||
        (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')))
      throw new Error('Unexpected agent response');
    settle(undefined, message);
  }

  child.stdout.on('data', (chunk) => {
    if (failure || stopping) return;
    try {
      bytes += chunk.length;
      if (bytes > outputLimit) throw new Error('Agent output exceeds its limit');
      for (let start = 0; start < chunk.length;) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end === -1 ? chunk.length : end);
        size += part.length;
        if (size > frameLimit) throw new Error('Agent frame exceeds its limit');
        frame.push(part);
        if (end === -1) break;
        dispatch(Buffer.concat(frame, size));
        frame = [];
        size = 0;
        start = end + 1;
      }
    } catch (error) {
      fail(error instanceof SyntaxError || error instanceof TypeError
        ? new Error('Malformed agent response') : error);
    }
  });
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-256); });
  child.stdin.on('error', () => { if (!stopping) fail(new Error('Agent input failed')); });
  child.on('error', () => fail(new Error('Agent supervisor failed to start')));
  void closed.then((code) => {
    signal?.removeEventListener('abort', abort);
    if (!stopping) {
      const reason = code === 124 ? 'Agent timed out'
        : code === 5 ? 'Agent stopped'
        : code === 4 ? 'Agent input queue is full'
        : code === 3 ? 'Agent input failed'
        : code === 2 ? 'Agent closed its output'
        : code === 0 ? 'Agent input closed' : 'Agent supervisor exited';
      failure ??= new Error(reason);
      settle(failure);
    }
  });

  function abort() {
    fail(new Error('Agent cancelled'));
  }
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  function stop() {
    if (!stopping) {
      stopping = (async () => {
        settle(failure ?? new Error('Agent stopped'));
        if (!child.stdin.destroyed) {
          child.stdin.write('LAB_M4_STOP\n');
          child.stdin.end();
        }
        const timer = new AbortController();
        const code = await Promise.race([
          closed,
          delay(5000, undefined, { signal: timer.signal, ref: false }),
        ]);
        timer.abort();
        if (code === undefined) {
          child.kill();
          throw new Error('Agent supervisor did not confirm STOP');
        }
        const confirmed = stopConfirmed(code, diagnostics);
        if (!confirmed) throw new Error('Agent job cleanup was not confirmed');
        return { before: confirmed.before, after: 0 };
      })();
    }
    return stopping;
  }

  return {
    closed,
    notify(method, params) { write({ method, params }); },
    request(method, params) {
      if (pending) return Promise.reject(new Error('An agent request is already pending'));
      return new Promise((resolve, reject) => {
        pending = { id: next++, resolve, reject };
        try { write({ id: pending.id, method, params }); }
        catch (error) { settle(error); }
      });
    },
    stop,
  };
}
