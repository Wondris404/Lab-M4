import { createInterface } from 'node:readline';
import { runPlanningSession } from './live-plan.mjs';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const controller = new AbortController();
const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pending;
let nextApproval = 0;
let started = false;

function approval(kind, detail) {
  if (controller.signal.aborted) return false;
  return new Promise((resolve) => {
    const id = ++nextApproval;
    pending = { id, resolve };
    output({ type: 'approval', id, kind, detail });
  });
}

async function run(settings) {
  try {
    output({ type: 'stage', stage: 'planning' });
    const result = await runPlanningSession({
      ...settings,
      signal: controller.signal,
      approve: (plan, scope) => approval('workers', { plan, scope }),
      approveTests: (command, changes) => approval('tests', { command, changes }),
      approveRepairs: (changes) => approval('repairs', { changes }),
      approveConflicts: (detail) => approval('conflicts', detail),
      approveIntegration: (detail) => approval('integration', detail),
      onStage: (stage) => output({ type: 'stage', stage }),
      onEvent: (event) => output({ type: 'event', event }),
    });
    for (const row of [...result.workers, ...result.project?.corrections ?? []]) {
      if (row.result?.evidence) delete row.result.text;
    }
    if (result.project?.integration?.review) delete result.project.integration.review.text;
    output({ type: 'result', result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Orchestration failed';
    output({ type: 'event', event: { type: 'failed', reason: message, at: Date.now() } });
    output({ type: 'error', error: message });
  } finally {
    input.close();
    process.stdin.pause();
  }
}

function stop() {
  controller.abort();
  pending?.resolve(false);
  pending = undefined;
}

input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { stop(); return; }
  if (message?.type === 'start' && !started) {
    started = true;
    void run(message.settings);
  } else if (message?.type === 'stop') {
    stop();
  } else if (message?.type === 'decision' && pending?.id === message.id) {
    const { resolve } = pending;
    pending = undefined;
    resolve(message.allow === true);
  }
});
input.on('close', stop);
