import { expect, it } from 'vitest';
import { createTerminalInput } from '../../../apps/desktop/src/terminalInput.js';

it('orders input per session and lets another session write during backpressure', async () => {
  const sent: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = createTerminalInput(async (id, input) => {
    sent.push(`${id}:${input}`);
    if (input === 'block') await blocked;
  });

  const first = write('a', 'block');
  const queued = Array.from({ length: 15 }, (_, index) => write('a', String(index)));
  try {
    await expect(write('a', 'overflow')).rejects.toThrow('queue is full');
    await write('b', 'independent');
    expect(sent).toEqual(['a:block', 'b:independent']);
  } finally {
    release();
    await Promise.all([first, ...queued]);
  }
  expect(sent.slice(2)).toEqual(Array.from({ length: 15 }, (_, index) => `a:${index}`));
});
