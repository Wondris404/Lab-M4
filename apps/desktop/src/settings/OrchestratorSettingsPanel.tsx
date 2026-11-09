import { AgentPicker, useModelCatalogs } from "../agent/AgentPicker";
import { agentLabel } from "../agent/orchestratorProviders";
import type { AppSettingsApi } from "./useAppSettings";
import { MAX_ORCHESTRATOR_WORKERS, MIN_ORCHESTRATOR_WORKERS, type OrchestratorAgentSetting } from "./types";

/** Settings → Orchestrátor: default orchestrator and the AIs it may assign tasks to. */
export function OrchestratorSettingsPanel({ api }: { api: AppSettingsApi }) {
  const { orchestrator } = api.settings;
  const { catalogs, loading, error, load } = useModelCatalogs();
  const setPool = (workerPool: OrchestratorAgentSetting[]) => api.setOrchestratorSettings({ workerPool });

  return <div className="settings-section orchestrator-settings">
    <p className="settings-section-hint">
      Orchestrátor riadi beh: rozdelí zadanie na úlohy, pre každú vyberie najvhodnejšiu AI, skontroluje jej
      výsledok a navrhne opravy. Zmeny sa ukladajú hneď a predvolia sa v okne orchestrátora.
    </p>

    <h3 className="orchestrator-settings-title">Predvolený orchestrátor</h3>
    <AgentPicker legend="Orchestrátor" agent={orchestrator.manager} catalog={catalogs[orchestrator.manager.provider]}
      onChange={(manager) => api.setOrchestratorSettings({ manager })} />
    <p className="settings-font-note">Aktuálne: {agentLabel(orchestrator.manager)}</p>

    <h3 className="orchestrator-settings-title">Výber AI pre úlohy</h3>
    <div className="orchestrator-segmented" role="radiogroup" aria-label="Výber AI pre úlohy">
      {([["auto", "Automaticky – vyberie orchestrátor"], ["manual", "Ručne v okne orchestrátora"]] as const).map(([value, label]) =>
        <label key={value} className={orchestrator.workerSelection === value ? "active" : ""}>
          <input type="radio" name="orchestrator-worker-selection" value={value}
            checked={orchestrator.workerSelection === value}
            onChange={() => api.setOrchestratorSettings({ workerSelection: value })} />
          {label}
        </label>)}
    </div>

    <h3 className="orchestrator-settings-title">AI, z ktorých orchestrátor vyberá</h3>
    <p className="settings-section-hint">
      {MIN_ORCHESTRATOR_WORKERS} až {MAX_ORCHESTRATOR_WORKERS} AI od rôznych firiem. Môžu pracovať naraz na rovnakom projekte;
      každá úloha dostane oddelenú pracovnú kópiu. Rovnakú AI môžeš pridať viackrát pre paralelné úlohy.
    </p>
    <div className="orchestration-agents">
      {orchestrator.workerPool.map((agent, index) => <AgentPicker key={index} legend={`W${index + 1}`} agent={agent}
        catalog={catalogs[agent.provider]}
        onChange={(next) => setPool(orchestrator.workerPool.map((row, i) => i === index ? next : row))}
        onRemove={orchestrator.workerPool.length > MIN_ORCHESTRATOR_WORKERS
          ? () => setPool(orchestrator.workerPool.filter((_, i) => i !== index)) : undefined}
        removeLabel={`Odobrať W${index + 1}`} />)}
    </div>
    <div className="orchestration-actions">
      <button type="button" className="appearance-reset" disabled={orchestrator.workerPool.length >= MAX_ORCHESTRATOR_WORKERS}
        onClick={() => {
          const used = new Set(orchestrator.workerPool.map(({ provider, model }) => `${provider}\u0000${model}`));
          const provider = (["codex", "grok", "opencode"] as const).find((id) => !used.has(`${id}\u0000`)) ?? "codex";
          setPool([...orchestrator.workerPool, { provider, model: "" }]);
        }}>Pridať AI</button>
      <button type="button" className="appearance-reset" disabled={loading}
        onClick={() => void load([orchestrator.manager.provider, ...orchestrator.workerPool.map(({ provider }) => provider)])}>
        {loading ? "Načítavam modely…" : "Načítať modely z CLI"}
      </button>
    </div>
    {error && <p className="settings-font-note" role="alert">{error}</p>}
  </div>;
}
