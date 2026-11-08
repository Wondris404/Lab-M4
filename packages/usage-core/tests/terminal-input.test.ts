import { expect, it } from 'vitest';
import { createTerminalInput } from '../../../apps/desktop/src/terminalInput.js';

it('batches fast keystrokes in order and lets another session write during backpressure', async () => {
  const sent: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = createTerminalInput(async (id, input) => {
    sent.push(`${id}:${input}`);
    if (input === 'block') await blocked;
  });

  const first = write('a', 'block');
  await Promise.resolve();
  const keys = Array.from({ length: 200 }, (_, index) => String(index % 10));
  const queued = keys.map((key) => write('a', key));
  try {
    await write('b', 'independent');
    expect(sent).toEqual(['a:block', 'b:independent']);
  } finally {
    release();
    await Promise.all([first, ...queued]);
  }
  expect(sent.slice(2)).toEqual([`a:${keys.join('')}`]);
});

it('rejects excess bytes explicitly and splits accepted input at the IPC limit', async () => {
  const batches: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = createTerminalInput(async (_id, input) => {
    batches.push(input);
    if (input === 'hold') await blocked;
  });
  const first = write('a', 'hold');
  await Promise.resolve();
  const big = 'x'.repeat(256 * 1024);
  const next = 'y'.repeat(128 * 1024);
  const queued = [write('a', big), write('a', next)];
  try {
    await expect(write('a', next)).rejects.toThrow('queue is full');
    await expect(write('a', `${big}z`)).rejects.toThrow('exceeds 256 KiB');
  } finally {
    release();
    await Promise.all([first, ...queued]);
  }
  expect(batches).toEqual(['hold', big, next]);
});
