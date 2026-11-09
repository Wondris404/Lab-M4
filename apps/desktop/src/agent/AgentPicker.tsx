import { invoke } from "@tauri-apps/api/core";
import { useCallback, useId, useRef, useState, type CSSProperties } from "react";
import type { ModelCatalog } from "../chat/ModelPicker";
import { ORCHESTRATOR_PROVIDERS, type OrchestratorAgentSetting, type OrchestratorProvider } from "../settings/types";
import { ORCHESTRATOR_PROVIDER_INFO } from "./orchestratorProviders";

export type ModelCatalogs = Partial<Record<OrchestratorProvider, ModelCatalog>>;

/** Loads model lists from the installed CLIs on demand (never automatically: it starts the CLIs). */
export function useModelCatalogs() {
  const [catalogs, setCatalogs] = useState<ModelCatalogs>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const load = useCallback(async (providers: Iterable<OrchestratorProvider>) => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError("");
    const failures: string[] = [];
    for (const provider of new Set(providers)) {
      try {
        const catalog = await invoke<ModelCatalog>("chat_models", { platform: ORCHESTRATOR_PROVIDER_INFO[provider].platform, model: null });
        setCatalogs((previous) => ({ ...previous, [provider]: catalog }));
      } catch (reason) {
        failures.push(`${ORCHESTRATOR_PROVIDER_INFO[provider].label} · ${String(reason)}`);
      }
    }
    setError(failures.join("\n"));
    setLoading(false);
    pending.current = false;
  }, []);
  return { catalogs, loading, error, load };
}

/** Company + model picker shared by the orchestrator window and the settings section. */
export function AgentPicker({ legend, agent, catalog, onChange, onRemove, removeLabel, disabled }: {
  legend: string; agent: OrchestratorAgentSetting; catalog?: ModelCatalog;
  onChange: (agent: OrchestratorAgentSetting) => void; onRemove?: () => void; removeLabel?: string; disabled?: boolean;
}) {
  const id = useId();
  const models = catalog?.models ?? [];
  const known = !agent.model || models.some(({ id: model }) => model === agent.model);
  const color = ORCHESTRATOR_PROVIDER_INFO[agent.provider].color;
  return <fieldset className="orchestration-agent" disabled={disabled}
    style={{ "--agent-color": `rgb(${color.join(" ")})` } as CSSProperties}>
    <legend><span className="orchestration-agent-dot" aria-hidden="true" />{legend}</legend>
    <label htmlFor={`${id}-provider`}>Firma / CLI</label>
    <select id={`${id}-provider`} value={agent.provider}
      onChange={(event) => onChange({ provider: event.target.value as OrchestratorProvider, model: "" })}>
      {ORCHESTRATOR_PROVIDERS.map((provider) =>
        <option key={provider} value={provider}>{ORCHESTRATOR_PROVIDER_INFO[provider].label}</option>)}
    </select>
    <label htmlFor={`${id}-model`}>Model</label>
    <select id={`${id}-model`} value={agent.model} onChange={(event) => onChange({ ...agent, model: event.target.value })}>
      <option value="">Predvolený model CLI</option>
      {!known && <option value={agent.model}>{agent.model} (uložený)</option>}
      {models.map(({ id: model, name }) => <option key={model} value={model}>{name}</option>)}
    </select>
    {onRemove && <button type="button" className="orchestration-agent-remove" onClick={onRemove}
      aria-label={removeLabel ?? `Odobrať ${legend}`}>Odobrať</button>}
  </fieldset>;
}
