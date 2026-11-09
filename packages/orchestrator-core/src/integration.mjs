import { captureProjectDiff } from './project-worktrees.mjs';

export async function prepareIntegration({
  workspace, snapshot, rows, overlaps, signal, onStage, request, resolveConflicts, runCheck, testCommand,
}) {
  const proposals = new Map();
  let review;
  try {
    for (const { id, result } of rows) {
      const files = JSON.parse(result.proposal).files;
      for (const { path, content } of files) {
        if (!result.evidence.changed.includes(path)) continue;
        if (!proposals.has(path)) proposals.set(path, []);
        proposals.get(path).push({ id, content });
      }
    }
    const combined = new Map([...proposals].filter(([, changes]) => changes.length === 1)
      .map(([path, [change]]) => [path, change.content]));
    let rationale = '';
    if (overlaps.length) {
      const changes = rows.filter(({ id }) => overlaps.some(({ tasks }) => tasks.includes(id)))
        .map(({ id, result }) => ({ id, ...result.evidence }));
      if (!await request('conflicts', { overlaps, changes })) return { status: 'conflicts-not-approved' };
      onStage?.('integrating');
      const conflicts = overlaps.map(({ path }) => ({ path, base: snapshot.entries.get(path), proposals: proposals.get(path) }));
      review = await resolveConflicts(conflicts);
      const resolution = JSON.parse(review.proposal);
      if (typeof resolution?.rationale !== 'string' || !resolution.rationale.trim() || resolution.rationale.length > 4000 ||
          !Array.isArray(resolution.files) || resolution.files.length !== overlaps.length) {
        throw new Error('Manager must explain how every overlapping file is reconciled');
      }
      const unresolved = new Set(overlaps.map(({ path }) => path));
      for (const { path, content } of resolution.files) {
        if (!unresolved.delete(path) || typeof content !== 'string' || content === snapshot.entries.get(path))
          throw new Error('Manager returned an invalid conflict resolution');
        combined.set(path, content);
      }
      rationale = resolution.rationale;
    }
    const proposal = JSON.stringify({ files: [...combined].map(([path, content]) => ({ path, content })) });
    const approvedPaths = [...combined.keys()];
    const evidence = await captureProjectDiff(workspace, snapshot, 'combined', approvedPaths, proposal, signal, 'integration');
    if (evidence.diffCheck.status !== 0) return { status: 'diff-failed', evidence, rationale, review };
    if (!await request('integration', { rationale, changes: [{ id: 'combined', ...evidence }] }))
      return { status: 'candidate-not-approved', evidence, rationale, review };
    let check = null;
    if (testCommand && await request('tests', { command: testCommand, changes: [{ id: 'combined', ...evidence }] })) {
      onStage?.('testing');
      const testCopy = await captureProjectDiff(workspace, snapshot, 'combined', approvedPaths, proposal, signal, 'integration-check');
      if (testCopy.diff !== evidence.diff) throw new Error('Integration test copy does not match the approved diff');
      check = await runCheck(testCopy.worktree);
    }
    return { status: check?.status === 0 ? 'verified' : check ? 'test-failed' : 'unverified', evidence, rationale, review, check };
  } catch (error) {
    return { status: signal?.aborted ? 'cancelled' : 'unavailable', review,
      reason: error instanceof Error ? error.message : 'Could not prepare integration' };
  }
}
