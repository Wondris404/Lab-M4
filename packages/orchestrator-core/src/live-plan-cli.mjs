import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { runPlanningSession } from './live-plan.mjs';

async function main([configPath, ...extra]) {
  if (!configPath || extra.length || !process.stdin.isTTY)
    throw new Error('Usage in an interactive terminal: pnpm orchestrator:plan <config.json>');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const controller = new AbortController();
  const input = createInterface({ input: process.stdin, output: process.stderr });
  const stop = () => controller.abort(new Error('Planning session cancelled'));
  process.on('SIGINT', stop);
  input.on('SIGINT', stop);
  const confirm = async (question) => {
    if (controller.signal.aborted) return false;
    const answer = await input.question(question, { signal: controller.signal }).catch(() => '');
    return answer.trim() === 'yes';
  };
  try {
    const result = await runPlanningSession({
      transport: config.transport, manager: config.manager, workers: config.workers,
      task: config.task, project: config.project, files: config.files, check: config.check, signal: controller.signal,
      async approve(plan, project) {
        console.error(JSON.stringify(plan, null, 2));
        if (project) console.error(`${project.base ? `Commit ${project.base}` : 'Selected files from disk'}: ${project.files.join(', ')}`);
        const question = project
          ? 'Send assigned file contents to workers and their diffs to the manager for review? Type yes to approve: '
          : 'Launch these workers for text proposals? Type yes to approve: ';
        return confirm(question);
      },
      approveTests(command, changes) {
        console.error(JSON.stringify({ command, changes }, null, 2));
        return confirm('Execute this command in the changed worktrees with your account permissions? Type yes to approve: ');
      },
      approveRepairs(changes) {
        console.error(JSON.stringify(changes, null, 2));
        return confirm('Let the manager request one correction from each listed worker? Type yes to approve: ');
      },
      approveConflicts(detail) {
        console.error(JSON.stringify(detail, null, 2));
        return confirm('Send the conflicting approved files to the manager to propose a resolution? Type yes to approve: ');
      },
      approveIntegration(detail) {
        console.error(JSON.stringify(detail, null, 2));
        return confirm('Accept this combined candidate in the isolated worktree? Type yes to approve: ');
      },
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'proposed' && result.project?.integration?.status !== 'verified') process.exitCode = 1;
  } finally {
    input.close();
    process.removeListener('SIGINT', stop);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : 'Planning session failed');
  process.exitCode = 1;
});
