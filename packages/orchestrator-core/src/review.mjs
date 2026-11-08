// Pure review of a worker diff and a test exit. Attempt counts are not an input.

export function reviewWorkerResult({ diff, test }) {
  if (typeof diff !== 'string' || !test || !Number.isInteger(test.status)) {
    throw new Error('Review requires a diff and a test result');
  }
  if (test.status !== 0) return { decision: 'repair', reason: 'tests-failed' };
  if (!/^diff --git /m.test(diff)) return { decision: 'repair', reason: 'empty-diff' };
  if (!/^\+corrected$/m.test(diff)) return { decision: 'repair', reason: 'diff-rejected' };
  return { decision: 'accept', reason: 'diff-and-tests' };
}
