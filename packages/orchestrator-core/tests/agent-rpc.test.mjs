import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { connectAgent } from '../src/agent-rpc.mjs';

function peer(script, signal) {
  const child = spawn(process.execPath, ['-e', `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    process.stdin.on('end', () => {
      process.stderr.write('LAB_M4_RESULT stop\\nLAB_M4_JOB_STOP 1 0\\n');
      process.exit(5);
    });
    ${script}
  `], { windowsHide: true });
  return connectAgent(child, { jsonrpc: true, signal });
}

test('refuses provider approval and decodes a response split inside UTF-8', { timeout: 8000 }, async () => {
  const agent = peer(`
    let original;
    lines.on('line', line => {
      if (line === 'LAB_M4_STOP') return;
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        original = message.id;
        console.log(JSON.stringify({ jsonrpc:'2.0', id:99, method:'session/request_permission' }));
        return;
      }
      const reply = Buffer.from(JSON.stringify({
        id:original, result:{ denied:message.id === 99 && message.error?.code === -32601, title:'ž' }
      }) + '\\n');
      const split = reply.indexOf(Buffer.from('ž')) + 1;
      process.stdout.write(reply.subarray(0, split));
      setTimeout(() => process.stdout.write(reply.subarray(split)), 50);
    });
  `);
  try {
    assert.deepEqual((await agent.request('initialize', {})).result, { denied: true, title: 'ž' });
  } finally {
    assert.deepEqual(await agent.stop(), { before: 1, after: 0 });
  }
});

test('rejects oversized unterminated output and stops the transport', { timeout: 8000 }, async () => {
  const agent = peer("lines.on('line', line => { if (line === 'LAB_M4_STOP') return; process.stdout.write(Buffer.alloc(1048577, 97)); });");
  await assert.rejects(agent.request('initialize', {}), /frame exceeds/);
  assert.deepEqual(await agent.stop(), { before: 1, after: 0 });
});

test('cancellation rejects pending RPC and confirms STOP once', { timeout: 8000 }, async () => {
  const controller = new AbortController();
  const agent = peer('', controller.signal);
  const request = agent.request('initialize', {});
  controller.abort();
  await assert.rejects(request, /cancelled/);
  const stopped = agent.stop();
  assert.equal(stopped, agent.stop());
  assert.deepEqual(await stopped, { before: 1, after: 0 });
});
