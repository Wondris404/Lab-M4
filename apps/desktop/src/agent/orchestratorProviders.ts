import {
  MAX_ORCHESTRATOR_WORKERS,
  MIN_ORCHESTRATOR_WORKERS,
  type OrchestratorAgentSetting,
  type OrchestratorProvider,
  type OrchestratorSettings,
  type WorkerSelection,
} from "../settings/types";

export interface ProviderInfo {
  /** Company · product, shown in pickers. */
  label: string;
  company: string;
  product: string;
  /** Platform id understood by the `chat_models` command. */
  platform: string;
  /** Brand-neutral accent used for this vendor's labels in the activity log (RGB). */
  color: readonly [number, number, number];
}

export const ORCHESTRATOR_PROVIDER_INFO: Record<OrchestratorProvider, ProviderInfo> = {
  codex: { label: "OpenAI · Codex", company: "OpenAI", product: "Codex", platform: "codex", color: [52, 199, 140] },
  grok: { label: "xAI · Grok Build", company: "xAI", product: "Grok Build", platform: "grok-build", color: [96, 165, 250] },
  opencode: { label: "OpenCode", company: "OpenCode", product: "OpenCode", platform: "opencode", color: [245, 166, 35] },
};

/** Accent for the orchestrator itself, independent of its vendor. */
export const MANAGER_COLOR: readonly [number, number, number] = [200, 140, 255];

export function providerInfo(provider: string): ProviderInfo {
  return ORCHESTRATOR_PROVIDER_INFO[provider as OrchestratorProvider] ?? {
    label: provider, company: provider, product: provider, platform: provider, color: [180, 180, 180],
  };
}

/** "Codex · gpt-5" or "Codex · predvolený model" for an agent without an explicit model. */
export function agentLabel(agent: { provider: string; model?: string | null }): string {
  return `${providerInfo(agent.provider).product} · ${agent.model ? agent.model : "predvolený model"}`;
}

export interface RunAgents {
  manager: OrchestratorAgentSetting;
  workers: OrchestratorAgentSetting[];
  selection: WorkerSelection;
}

/**
 * Agents for one run. In automatic mode the orchestrator receives the whole configured
 * pool and assigns every task to the worker it considers best; in manual mode the
 * user's explicit worker list is used.
 */
export function buildRunAgents({ settings, manager, selection, manualWorkers }: {
  settings: OrchestratorSettings;
  manager?: OrchestratorAgentSetting;
  selection?: WorkerSelection;
  manualWorkers?: OrchestratorAgentSetting[];
}): RunAgents {
  const mode = selection ?? settings.workerSelection;
  const source = mode === "manual" && manualWorkers ? manualWorkers : settings.workerPool;
  const workers = source.slice(0, MAX_ORCHESTRATOR_WORKERS).map((agent) => ({ ...agent }));
  if (workers.length < MIN_ORCHESTRATOR_WORKERS) {
    throw new Error(`Orchestrátor potrebuje aspoň ${MIN_ORCHESTRATOR_WORKERS} AI workerov.`);
  }
  return { manager: { ...(manager ?? settings.manager) }, workers, selection: mode };
}

/** Payload for the `orchestration_start` command (empty model means the CLI default). */
export function toBackendAgent(agent: OrchestratorAgentSetting) {
  return { provider: agent.provider, model: agent.model.trim() || null };
}
