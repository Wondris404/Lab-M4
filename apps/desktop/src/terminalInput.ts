import { invoke } from "@tauri-apps/api/core";

const MAX_PENDING = 16;
const MAX_INPUT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

type Pending = { count: number; tail: Promise<void> };

export function createTerminalInput(send: (id: string, input: string) => Promise<void>) {
  const pending = new Map<string, Pending>();

  return async (id: string, input: string): Promise<void> => {
    if (input.length > MAX_INPUT_BYTES || encoder.encode(input).byteLength > MAX_INPUT_BYTES) {
      throw new Error("Terminal input exceeds 256 KiB");
    }
    const queue = pending.get(id) ?? { count: 0, tail: Promise.resolve() };
    if (queue.count >= MAX_PENDING) {
      throw new Error("Terminal input queue is full");
    }
    pending.set(id, queue);
    queue.count++;
    const write = queue.tail.then(() => send(id, input));
    queue.tail = write.catch(() => undefined);
    try {
      await write;
    } finally {
      queue.count--;
      if (queue.count === 0) pending.delete(id);
    }
  };
}

export const writeTerminalInput = createTerminalInput((id, input) =>
  invoke<void>("write_powershell", { id, input })
);
