import { invoke } from "@tauri-apps/api/core";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_PENDING_WRITES = 4096;
const encoder = new TextEncoder();

type Write = {
  input: string;
  bytes: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Queue = { writes: Write[]; count: number; bytes: number };

export function createTerminalInput(send: (id: string, input: string) => Promise<void>) {
  const pending = new Map<string, Queue>();

  async function flush(id: string, queue: Queue) {
    while (queue.writes.length > 0) {
      let end = 0;
      let bytes = 0;
      for (const write of queue.writes) {
        if (bytes + write.bytes > MAX_INPUT_BYTES) break;
        bytes += write.bytes;
        end++;
      }
      const batch = queue.writes.splice(0, end);
      try {
        await send(id, batch.map(({ input }) => input).join(""));
        for (const write of batch) write.resolve();
      } catch (error) {
        for (const write of batch) write.reject(error);
      } finally {
        queue.count -= batch.length;
        queue.bytes -= bytes;
      }
    }
    pending.delete(id);
  }

  return async (id: string, input: string): Promise<void> => {
    if (input.length === 0) return;
    if (input.length > MAX_INPUT_BYTES) throw new Error("Terminal input exceeds 256 KiB");
    const bytes = encoder.encode(input).byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Terminal input exceeds 256 KiB");
    const existing = pending.get(id);
    const queue = existing ?? { writes: [], count: 0, bytes: 0 };
    if (queue.count >= MAX_PENDING_WRITES || queue.bytes + bytes > MAX_PENDING_BYTES) {
      throw new Error("Terminal input queue is full");
    }
    return new Promise<void>((resolve, reject) => {
      queue.writes.push({ input, bytes, resolve, reject });
      queue.count++;
      queue.bytes += bytes;
      if (!existing) {
        pending.set(id, queue);
        queueMicrotask(() => { void flush(id, queue); });
      }
    });
  };
}

export const writeTerminalInput = createTerminalInput((id, input) =>
  invoke<void>("write_powershell", { id, input })
);
