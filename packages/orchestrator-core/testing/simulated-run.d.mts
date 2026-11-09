// Types for the simulation-only helper (see simulated-run.mjs).
export declare const simulatedAgents: {
  manager: { provider: string; executable: string; model: string };
  workers: readonly { provider: string; executable: string; model: string }[];
};
export declare const simulatedTask: string;
export declare function runSimulatedSession(options?: {
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
  speed?: number; root?: string; signal?: AbortSignal;
}): Promise<{ result: unknown; events: (Record<string, unknown> & { type: string })[]; project: string }>;
