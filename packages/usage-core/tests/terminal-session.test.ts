import { expect, it } from 'vitest';
import { createTerminalSession } from '../../../apps/desktop/src/terminalSession.js';

it('reports an invoke failure and permits a successful retry', async () => {
  let error: string | null = null;
  const report = (message: string | null) => { error = message; };
  let sessions = 0;
  await createTerminalSession(async () => {
    throw new Error('spawn failed');
  }, report);
  expect(error).toBe('spawn failed');
  expect(sessions).toBe(0);

  await createTerminalSession(async () => { sessions++; }, report);
  expect(error).toBeNull();
  expect(sessions).toBe(1);
});
