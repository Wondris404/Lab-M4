import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('answers the ConPTY cursor-position request before a terminal is opened', async () => {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
  const require = createRequire(resolve('apps/desktop/package.json'));
  const { Terminal } = require('@xterm/xterm') as {
    Terminal: new (options: { cols: number; rows: number }) => {
      onData(callback: (data: string) => void): unknown;
      write(data: string, callback: () => void): void;
      dispose(): void;
    };
  };
  const terminal = new Terminal({ cols: 80, rows: 24 });
  let response = '';
  terminal.onData((data: string) => { response += data; });
  try {
    await new Promise<void>((done) => terminal.write('\x1b[6n', done));
    expect(response).toBe('\x1b[1;1R');
  } finally {
    terminal.dispose();
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else Reflect.deleteProperty(globalThis, 'self');
  }
});
