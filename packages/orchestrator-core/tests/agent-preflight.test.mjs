import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { agentHomeEnv } from '../src/agent-preflight.mjs';

test('preflight keeps provider homes stable and does not copy the user profile', () => {
  const scratch = join('C:\\lab-m4-scratch', 'run');
  const homeRoot = join('C:\\repo', '.lab-m4', 'agent-homes');
  const env = agentHomeEnv('C:\\Windows', scratch, homeRoot);
  assert.equal(env.CODEX_HOME, join(homeRoot, 'codex'));
  assert.equal(env.GROK_HOME, join(homeRoot, 'grok'));
  assert.equal(env.USERPROFILE, scratch);
  assert.equal(env.HOME, scratch);
  assert.equal(env.PATH, join('C:\\Windows', 'System32'));
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
  assert.notEqual(env.CODEX_HOME, join(scratch, 'codex'));
});
