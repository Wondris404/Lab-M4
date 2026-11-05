export type Agent = 'codex' | 'grok-build' | 'opencode' | 'antigravity';
export interface UsageSource { id: string; agent: Agent; name: string }
export interface UsageRecord {
  agent: Agent; model: string; session: string; timestamp: string;
  input: number; output: number; cached: number; reasoning: number;
  cost?: number; warnings: string[];
}
