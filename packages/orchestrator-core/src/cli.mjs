#!/usr/bin/env node
import { createFakeSession, decideFakeApproval, resumeFake, stepFake, stopFake } from './fake-engine.mjs';
import { createSession, listSessions, loadSession, updateSession } from './fake-store.mjs';

const help = `FAKE SIMULATION ONLY — no Codex or Grok adapter and no billing.
This CLI does not spawn a shipped transport, so its stop cancels fake state only.
  node packages/orchestrator-core/src/cli.mjs start --fake
  node packages/orchestrator-core/src/cli.mjs list
  node packages/orchestrator-core/src/cli.mjs status|events|budget <session-id>
  node packages/orchestrator-core/src/cli.mjs step|stop|resume <session-id>
  node packages/orchestrator-core/src/cli.mjs approve|deny <session-id> <approval-id>`;

async function main(args) {
  const [command, id, approval, ...extra] = args;
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === 'start') {
    if (id !== '--fake' || approval || extra.length) throw new Error('Only the explicit --fake simulation is supported');
    const state = createFakeSession(); await createSession(state); console.log(JSON.stringify(state, null, 2)); return;
  }
  if (command === 'list') {
    if (id) throw new Error('Unexpected arguments');
    console.log(JSON.stringify((await listSessions()).map(({ id, status, mode }) => ({ id, status, mode })), null, 2)); return;
  }
  if (!id || extra.length) throw new Error('Invalid arguments');
  if (['status', 'events', 'budget'].includes(command)) {
    if (approval) throw new Error('Unexpected arguments');
    const state = await loadSession(id);
    console.log(JSON.stringify(command === 'status' ? state : command === 'events' ? state.events : state.budget, null, 2)); return;
  }
  let apply;
  if (command === 'approve' || command === 'deny') {
    if (!approval) throw new Error('Approval ID is required');
    apply = (state) => decideFakeApproval(state, approval, command);
  } else {
    if (approval) throw new Error('Unexpected arguments');
    apply = command === 'step' ? stepFake : command === 'stop' ? stopFake : command === 'resume' ? resumeFake : null;
  }
  if (!apply) throw new Error('Unsupported command; live adapters are disabled');
  console.log(JSON.stringify(await updateSession(id, apply), null, 2));
}
main(process.argv.slice(2)).catch((error) => { console.error(`FAKE ERROR: ${error.message}`); process.exitCode = 1; });
