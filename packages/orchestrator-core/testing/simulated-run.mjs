// SIMULATION ONLY. Never imported by the desktop bridge or any production code.
//
// Drives the real `runPlanningSession` with a scripted `runTurn` instead of real
// AI CLIs, so tests and the UI preview can show a deterministic multi-agent run
// (three vendors working concurrently, a failing diff check, one repair round).
// Model names are placeholders; no provider is contacted and no tokens are spent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanningSession } from '../src/live-plan.mjs';

export const simulatedAgents = Object.freeze({
  manager: Object.freeze({ provider: 'codex', executable: 'simulated', model: 'sim-codex-manager' }),
  workers: Object.freeze([
    Object.freeze({ provider: 'codex', executable: 'simulated', model: 'sim-codex-worker' }),
    Object.freeze({ provider: 'grok', executable: 'simulated', model: 'sim-grok-worker' }),
    Object.freeze({ provider: 'opencode', executable: 'simulated', model: 'sim-opencode-worker' }),
  ]),
});

export const simulatedTask = 'Pridaj do aplikácie prepínač tmavého režimu a zdokumentuj ho';

const files = {
  'src/theme.ts': 'export const themes = ["light"];\n',
  'src/toggle.tsx': 'export function Toggle() {\n  return null;\n}\n',
  'README.md': '# Demo\n',
};

const plan = {
  tasks: [
    { id: 'theme', worker: 0, task: 'Pridaj tmavú tému do zoznamu tém', dependsOn: [], files: ['src/theme.ts'],
      reason: 'Codex je silný v typovanom TypeScripte a malých presných zmenách.' },
    { id: 'toggle', worker: 1, task: 'Vytvor komponent prepínača tém', dependsOn: [], files: ['src/toggle.tsx'],
      reason: 'Grok Build rýchlo navrhuje React komponenty.' },
    { id: 'docs', worker: 2, task: 'Zdokumentuj prepínač v README', dependsOn: [], files: ['README.md'],
      reason: 'Lacný a rýchly model cez OpenCode stačí na dokumentáciu.' },
  ],
};

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Simulated turn cancelled')); }, { once: true });
});

function scriptedTurn(speed) {
  let reviews = 0;
  return async ({ prompt, model, signal }) => {
    if (prompt.startsWith('You are coordinating')) {
      await delay(60 * speed, signal);
      return { text: JSON.stringify(plan), tokens: 1840, model };
    }
    if (prompt.startsWith('Review these real Git diffs')) {
      reviews += 1;
      await delay(50 * speed, signal);
      return reviews === 1
        ? { text: JSON.stringify({ summary: 'Téma a dokumentácia sú v poriadku. Prepínač má koncové medzery, treba ho opraviť.', repairTaskIds: ['toggle'] }), tokens: 2310, model }
        : { text: JSON.stringify({ summary: 'Po oprave sú všetky tri návrhy pripravené na integráciu.', repairTaskIds: [] }), tokens: 1990, model };
    }
    if (prompt.startsWith('Reconcile overlapping')) throw new Error('No overlaps expected in the simulation');
    const correction = prompt.includes('"correction"');
    if (prompt.includes('src/theme.ts')) {
      await delay(40 * speed, signal);
      return { text: JSON.stringify({ files: [{ path: 'src/theme.ts', content: 'export const themes = ["light", "dark"];\n' }] }), tokens: 920, model };
    }
    if (prompt.includes('src/toggle.tsx')) {
      await delay(70 * speed, signal);
      const content = correction
        ? 'export function Toggle({ onToggle }: { onToggle: () => void }) {\n  return <button onClick={onToggle}>Tmavý režim</button>;\n}\n'
        : 'export function Toggle({ onToggle }: { onToggle: () => void }) {   \n  return <button onClick={onToggle}>Tmavý režim</button>;\n}\n';
      return { text: JSON.stringify({ files: [{ path: 'src/toggle.tsx', content }] }), tokens: correction ? 640 : 1180, model };
    }
    await delay(30 * speed, signal);
    return { text: JSON.stringify({ files: [{ path: 'README.md', content: '# Demo\n\nPrepínač tmavého režimu je v hlavičke.\n' }] }), tokens: 410, model };
  };
}

function createSimulatedProject(root) {
  const project = mkdtempSync(join(root ?? tmpdir(), 'labm4-sim-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  return project;
}

/** Runs a full simulated session and returns its result plus every activity event. */
export async function runSimulatedSession({ onEvent, speed = 1, root, signal } = {}) {
  const events = [];
  const project = createSimulatedProject(root);
  execFileSync('git', ['--version']);
  const result = await runPlanningSession({
    transport: 'simulated', ...simulatedAgents, task: simulatedTask, project, files: Object.keys(files), signal,
    check: { executable: join(project, 'simulated-check.exe'), args: ['test'] },
    approve: () => true, approveTests: () => true, approveRepairs: () => true, approveIntegration: () => true,
    runCheck: async ({ signal: checkSignal }) => { await delay(25 * speed, checkSignal); return { status: 0 }; },
    onEvent(event) { events.push(event); onEvent?.(event); },
    runTurn: scriptedTurn(speed),
  });
  return { result, events, project };
}
