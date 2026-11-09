import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  MAX_ORCHESTRATOR_WORKERS,
  MIN_ORCHESTRATOR_WORKERS,
  type OrchestratorAgentSetting,
  type OrchestratorSettings,
  type WorkerSelection,
} from "../settings/types";
import { AgentPicker, useModelCatalogs } from "./AgentPicker";
import { STAGE_LABELS } from "./orchestratorEvents";
import { agentLabel, buildRunAgents, providerInfo, toBackendAgent, type RunAgents } from "./orchestratorProviders";
import "./orchestrator.css";
import { COMPLETED_STAGES, type Evidence, type OrchestrationRun, type Report } from "./useOrchestrationRun";

const resultLabels: Record<string, string> = {
  proposed: "Návrh pripravený", "needs-repair": "Diff potrebuje opravu", blocked: "Čaká na vyriešenie závislosti",
  cancelled: "Zastavené", failed: "Zlyhalo", "not-approved": "Plán zamietnutý", incomplete: "Niektoré úlohy sa nedokončili",
  "needs-review": "Výsledky pripravené na kontrolu",
};
const approvalTitles = {
  workers: "Schváliť plán a zdieľanie súborov", tests: "Schváliť spustenie testov",
  repairs: "Schváliť jedno kolo opráv", conflicts: "Schváliť riešenie prekrývajúcich sa úprav",
  integration: "Schváliť spoločnú pracovnú kópiu",
} as const;
const integrationLabels: Record<string, string> = {
  verified: "Schválený kandidát prešiel testom", unverified: "Schválený kandidát čaká na overenie",
  "conflicts-not-approved": "Riešenie konfliktov nebolo schválené",
  "candidate-not-approved": "Spoločný návrh nebol schválený", "diff-failed": "Kontrola spoločného diffu zlyhala",
  "test-failed": "Test spoločnej pracovnej kópie zlyhal", unavailable: "Spoločný návrh sa nepodarilo pripraviť", cancelled: "Zastavené",
};
const number = new Intl.NumberFormat("sk");
const usd = new Intl.NumberFormat("sk", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const colorStyle = (provider: string) =>
  ({ "--agent-color": `rgb(${providerInfo(provider).color.join(" ")})` }) as CSSProperties;

function AgentChip({ agent, tag }: { agent: { provider: string; model?: string | null }; tag?: string }) {
  return <span className="orchestrator-chip" style={colorStyle(agent.provider)}>
    <span className="orchestration-agent-dot" aria-hidden="true" />
    {tag && <strong>{tag}</strong>}
    {agentLabel(agent)}
  </span>;
}

function Diff({ evidence }: { evidence: Evidence }) {
  return <details>
    <summary>Git diff · {evidence.diffCheck.status === 0 ? "Kontrola prešla" : "Kontrola zlyhala"}</summary>
    {evidence.worktree && <p className="orchestration-path">{evidence.worktree}</p>}
    <pre>{evidence.diff}</pre>
    {evidence.diffCheck.output && <pre>{evidence.diffCheck.output}</pre>}
  </details>;
}

function ReportView({ report }: { report: Report }) {
  const project = report.project;
  const review = project?.finalReview ?? project?.review;
  const turns = [
    report.manager, ...report.workers?.map(({ result }) => result) ?? [],
    project?.review?.result, ...project?.corrections?.map(({ result }) => result) ?? [], project?.finalReview?.result,
    project?.integration?.review,
  ].filter((turn): turn is NonNullable<typeof turn> & { provider: string } => Boolean(turn?.provider));
  return <section className="orchestration-card" aria-labelledby="orchestration-result">
    <h3 id="orchestration-result">{resultLabels[report.status] ?? report.status}</h3>
    {report.cleanupConfirmed && <p>Windows potvrdil ukončenie všetkých procesov behu.</p>}
    {project && <>
      <p className="orchestration-path">{project.workspace}</p>
      {project.remainingOverlaps.length > 0 && <div>
        <h4>Prekrývajúce sa úpravy</h4>
        <ul>{project.remainingOverlaps.map(({ path, tasks }) => <li key={path}>{path} · {tasks.join(", ")}</li>)}</ul>
      </div>}
      {project.open.length > 0 && <div>
        <h4>Otvorené úlohy</h4>
        <ul>{project.open.map(({ id, reason, testExit }) =>
          <li key={id}>{id} · {reason}{testExit != null && <> ({testExit})</>}</li>)}</ul>
      </div>}
      {[...report.workers ?? [], ...project.corrections].map((worker, index) => {
        const correction = index >= (report.workers?.length ?? 0);
        const check = (correction ? project.correctionChecks?.checks : project.checks)?.[worker.id];
        return <div className="orchestration-result-row" key={`${worker.id}-${correction}`}>
          <strong>{worker.id}{correction && " · oprava"}</strong>
          <span>{resultLabels[worker.status] ?? worker.status}</span>
          <span>Výsledok testu · {check?.status === 0 ? "Prešiel" : check?.status ?? "Neznáme"}</span>
          {worker.error && <p>{worker.error}</p>}
          {worker.result?.evidence && <Diff evidence={worker.result.evidence} />}
        </div>;
      })}
      <h4>Posúdenie orchestrátora</h4>
      <p className="orchestration-review">{review?.result?.text ?? review?.reason ?? "Neznáme"}</p>
      {project.integration && <div>
        <h4>Spoločná pracovná kópia</h4>
        <p>{integrationLabels[project.integration.status] ?? project.integration.status}</p>
        <p className="orchestration-review">{project.integration.rationale || project.integration.reason}</p>
        <p>Výsledok testu · {project.integration.check?.status ?? "Neznáme"}</p>
        {project.integration.evidence && <Diff evidence={project.integration.evidence} />}
      </div>}
    </>}
    <h4>Spotreba</h4>
    {turns.length > 0 ? <ul>{turns.map((turn, index) => <li key={index}>
      {providerInfo(turn.provider).label} · {turn.model ?? "Neznámy model"} · {turn.tokens == null ? "Tokeny neznáme" : `${number.format(turn.tokens)} tokenov`}
      {turn.contextLimit != null && <> · Kontextový limit {number.format(turn.contextLimit)} tokenov</>}
      {turn.estimatedUsd != null && <> · Odhad {usd.format(turn.estimatedUsd)}</>}
    </li>)}</ul> : <p>Tokeny · Neznáme</p>}
    <p>Fakturovaná suma · Neznáme · Limity účtu · Neznáme</p>
  </section>;
}

const FOCUSABLE = "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, a[href]";

/**
 * Small orchestrator window shown over the terminal / chat: pick the orchestrator and the
 * task, then follow approvals and results while the activity streams into the terminal.
 */
export function OrchestratorDialog({ open, onClose, run, settings, sessionName, sessionFolder, onOpenSettings, viewLabel }: {
  open: boolean; onClose: () => void; run: OrchestrationRun; settings: OrchestratorSettings;
  sessionName?: string; sessionFolder?: string; onOpenSettings: () => void; viewLabel: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [folder, setFolder] = useState<string>();
  const [files, setFiles] = useState("");
  const [task, setTask] = useState("");
  const [manager, setManager] = useState<OrchestratorAgentSetting>(settings.manager);
  const [managerTouched, setManagerTouched] = useState(false);
  const [selection, setSelection] = useState<WorkerSelection>(settings.workerSelection);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [manualWorkers, setManualWorkers] = useState<OrchestratorAgentSetting[]>(settings.workerPool);
  const [checkExecutable, setCheckExecutable] = useState("");
  const [checkArgs, setCheckArgs] = useState("");
  const [view, setView] = useState<"form" | "run">("form");
  const [formError, setFormError] = useState("");
  const [startedAgents, setStartedAgents] = useState<RunAgents | null>(null);
  const { catalogs, loading: catalogBusy, error: catalogError, load: loadModels } = useModelCatalogs();
  const { snapshot, running, busy, error, action, start } = run;
  const project = folder ?? sessionFolder ?? "";
  const approval = snapshot?.approval ?? null;
  const showRun = view === "run" || running;
  // The roster reported by the core is authoritative; fall back to what this window started.
  const runStart = run.events.items.find((event) => event.type === "run-start");
  const runRoster = runStart?.type === "run-start"
    ? { manager: runStart.manager, workers: runStart.workers }
    : startedAgents && { manager: startedAgents.manager, workers: startedAgents.workers };

  // Follow the saved defaults until the user changes them for this run.
  useEffect(() => { if (!managerTouched) setManager(settings.manager); }, [settings.manager, managerTouched]);
  useEffect(() => { if (!selectionTouched) setSelection(settings.workerSelection); }, [settings.workerSelection, selectionTouched]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  // Escape hides the window even when focus moved out (e.g. an approval button unmounted).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Node | null;
      if (target instanceof Element && target.closest("[role=dialog]") && !dialogRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Keep keyboard focus inside the window when an approval appears or is resolved.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    (dialog.querySelector<HTMLElement>(".orchestrator-approval .orchestration-primary") ?? dialog).focus();
  }, [open, approval?.id]);

  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }

  async function chooseFolder() {
    try {
      const path = await openDialog({ directory: true, multiple: false });
      if (typeof path === "string") setFolder(path);
    } catch (reason) { setFormError(String(reason)); }
  }

  async function chooseFiles() {
    setFormError("");
    try {
      const selected = await openDialog({ defaultPath: project.trim(), multiple: true });
      if (!selected) return;
      const prefix = `${project.trim().replace(/\\/g, "/").replace(/\/+$/, "")}/`;
      const paths = (Array.isArray(selected) ? selected : [selected]).map((path) => path.replace(/\\/g, "/"));
      if (paths.some((path) => !path.toLowerCase().startsWith(prefix.toLowerCase()))) {
        setFormError("Vyber súbory z priečinka projektu alebo z jeho podpriečinkov.");
        return;
      }
      setFiles(paths.map((path) => path.slice(prefix.length)).join("\n"));
    } catch (reason) { setFormError(String(reason)); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    const fileList = files.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!task.trim()) return setFormError("Napíš, čo má orchestrátor urobiť.");
    if (!project.trim()) return setFormError("Vyber priečinok projektu.");
    if (!fileList.length || fileList.length > 12) return setFormError("Vyber 1 až 12 súborov na úpravu.");
    let agents;
    try {
      agents = buildRunAgents({ settings, manager, selection, manualWorkers });
    } catch (reason) {
      return setFormError(reason instanceof Error ? reason.message : String(reason));
    }
    const started = await start({
      project: project.trim(), files: fileList, task: task.trim(),
      manager: toBackendAgent(agents.manager), workers: agents.workers.map(toBackendAgent),
      check: checkExecutable.trim() ? { executable: checkExecutable.trim(), args: checkArgs ? checkArgs.split(/\r?\n/) : [] } : null,
    });
    if (started) {
      setStartedAgents(agents);
      setView("run");
    }
  }

  const stageLabel = snapshot ? STAGE_LABELS[snapshot.stage] ?? snapshot.stage : null;
  const providersInUse = [manager.provider, ...(selection === "manual" ? manualWorkers : settings.workerPool).map(({ provider }) => provider)];

  return <div className="orchestrator-dialog-layer" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialogRef} className="orchestrator-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="orchestrator-dialog-header">
        <span className="workspace-orchestrator-icon" aria-hidden="true" />
        <div className="orchestrator-dialog-heading">
          <h2 id={titleId}>Orchestrátor</h2>
          <p>{sessionName ?? "Žiadna aktívna relácia"}</p>
        </div>
        {stageLabel && <span className={`orchestrator-stage ${running ? "running" : ""}`} role="status">{stageLabel}</span>}
        <button type="button" className="orchestrator-dialog-close" aria-label="Skryť okno orchestrátora"
          title="Skryť (Esc) · beh pokračuje" onClick={onClose}>×</button>
      </header>

      <div className="orchestrator-dialog-body">
        {!showRun && <form id={`${titleId}-form`} className="orchestrator-form" onSubmit={(event) => void submit(event)} noValidate>
          <AgentPicker legend="Orchestrátor" agent={manager} catalog={catalogs[manager.provider]}
            onChange={(agent) => { setManager(agent); setManagerTouched(true); }} />
          <p className="orchestrator-hint">
            Orchestrátor rozdelí zadanie na úlohy, pre každú vyberie AI a skontroluje ich výsledky.
            Predvolený orchestrátor nastavíš v <button type="button" className="orchestrator-link" onClick={onOpenSettings}>Nastavenia → Orchestrátor</button>.
          </p>

          <label className="orchestrator-field">Čo má urobiť
            <textarea data-autofocus value={task} onChange={(event) => setTask(event.target.value)} rows={3}
              placeholder="Napr. Pridaj prepínač tmavého režimu a zdokumentuj ho v README" required />
          </label>

          <fieldset className="orchestrator-group">
            <legend>Projekt</legend>
            <div className="orchestrator-inline">
              <label className="orchestrator-field">Priečinok projektu
                <input value={project} onChange={(event) => setFolder(event.target.value)} placeholder="Absolútna cesta k projektu" required />
              </label>
              <button type="button" onClick={() => void chooseFolder()}>Vybrať…</button>
            </div>
            <div className="orchestrator-inline">
              <label className="orchestrator-field">Súbory na úpravu · jedna relatívna cesta na riadok
                <textarea value={files} onChange={(event) => setFiles(event.target.value)} placeholder="README.md" rows={2} required />
              </label>
              <button type="button" disabled={!project.trim()} onClick={() => void chooseFiles()}>Vybrať…</button>
            </div>
            <p className="orchestrator-hint">Pri koreni Git repozitára sa použije posledný commit, inak vybrané súbory z disku. Obsah súborov sa odošle až po schválení plánu.</p>
          </fieldset>

          <fieldset className="orchestrator-group">
            <legend>AI workeri</legend>
            <div className="orchestrator-segmented" role="radiogroup" aria-label="Výber AI workerov">
              {([["auto", "Vyberie orchestrátor"], ["manual", "Vyberiem sám"]] as const).map(([value, label]) =>
                <label key={value} className={selection === value ? "active" : ""}>
                  <input type="radio" name={`${titleId}-selection`} value={value} checked={selection === value}
                    onChange={() => { setSelection(value); setSelectionTouched(true); }} />
                  {label}
                </label>)}
            </div>
            {selection === "auto" ? <>
              <p className="orchestrator-hint">Orchestrátor pridelí každú úlohu najvhodnejšej AI z týchto možností a zdôvodní prečo:</p>
              <div className="orchestrator-chips">
                {settings.workerPool.map((agent, index) => <AgentChip key={index} agent={agent} tag={`W${index + 1}`} />)}
                <button type="button" className="orchestrator-link" onClick={onOpenSettings}>Upraviť…</button>
              </div>
            </> : <>
              <div className="orchestration-agents">
                {manualWorkers.map((worker, index) => <AgentPicker key={index} legend={`Worker ${index + 1}`} agent={worker}
                  catalog={catalogs[worker.provider]}
                  onChange={(agent) => setManualWorkers((rows) => rows.map((row, i) => i === index ? agent : row))}
                  onRemove={manualWorkers.length > MIN_ORCHESTRATOR_WORKERS
                    ? () => setManualWorkers((rows) => rows.filter((_, i) => i !== index)) : undefined} />)}
              </div>
              <button type="button" disabled={manualWorkers.length >= MAX_ORCHESTRATOR_WORKERS}
                onClick={() => setManualWorkers((rows) => [...rows, { provider: "codex", model: "" }])}>Pridať workera</button>
            </>}
            <button type="button" className="orchestrator-secondary" disabled={catalogBusy}
              onClick={() => void loadModels(providersInUse)}>{catalogBusy ? "Načítavam modely…" : "Načítať modely z CLI"}</button>
            {catalogError && <p className="orchestration-review" role="alert">{catalogError}</p>}
          </fieldset>

          <details className="orchestrator-group">
            <summary>Voliteľný testovací príkaz</summary>
            <label className="orchestrator-field">Absolútna cesta k testovaciemu programu (.exe)
              <input value={checkExecutable} onChange={(event) => setCheckExecutable(event.target.value)} />
            </label>
            <label className="orchestrator-field">Argumenty · jeden na riadok
              <textarea value={checkArgs} onChange={(event) => setCheckArgs(event.target.value)} rows={2} />
            </label>
          </details>
        </form>}

        {showRun && snapshot && <section className="orchestration-card orchestrator-run" aria-label="Stav behu">
          {runRoster && <div className="orchestrator-chips">
            <AgentChip agent={runRoster.manager} tag="ORCH" />
            {runRoster.workers.map((agent, index) => <AgentChip key={index} agent={agent} tag={`W${index + 1}`} />)}
          </div>}
          <p>Čo agenti práve robia, sa zobrazuje {viewLabel}. Toto okno môžeš skryť, beh pokračuje a pri schválení sa znova otvorí.</p>
          {snapshot.error && <p className="orchestration-review" role="alert">{snapshot.error}</p>}
        </section>}

        {(formError || error) && <p className="orchestration-review orchestrator-error" role="alert">{formError || error}</p>}

        {approval && <section className="orchestration-card orchestrator-approval" aria-labelledby={`${titleId}-approval`}>
          <h3 id={`${titleId}-approval`}>{approvalTitles[approval.kind]}</h3>
          {approval.detail.scope && <p>{approval.detail.scope.base
            ? `Commit ${approval.detail.scope.base}`
            : "Vybrané súbory z disku sa spracujú v oddelenej pracovnej kópii."}</p>}
          {approval.detail.plan && <ol className="orchestrator-plan">{approval.detail.plan.map((entry) => {
            const agent = runRoster?.workers[entry.worker];
            return <li key={entry.id}>
              <div className="orchestrator-plan-head">
                <strong>{entry.id}</strong>
                {agent ? <AgentChip agent={agent} tag={`W${entry.worker + 1}`} /> : <span>Worker {entry.worker + 1}</span>}
              </div>
              <p>{entry.task}</p>
              {entry.reason && <p className="orchestrator-reason">Prečo: {entry.reason}</p>}
              <p className="orchestrator-hint">{entry.files?.join(", ")}{entry.dependsOn.length > 0 && ` · Po úlohách ${entry.dependsOn.join(", ")}`}</p>
            </li>;
          })}</ol>}
          {approval.detail.command && <>
            <p>Príkaz sa spustí s oprávneniami tvojho účtu v testovacích kópiách.</p>
            <pre>{JSON.stringify(approval.detail.command, null, 2)}</pre>
          </>}
          {approval.detail.overlaps && <>
            <p>Orchestrátor dostane úplný obsah uvedených súborov z pôvodného commitu a návrhy workerov.</p>
            <ul>{approval.detail.overlaps.map(({ path, tasks }) => <li key={path}>{path} · {tasks.join(", ")}</li>)}</ul>
          </>}
          {approval.kind === "integration" && <p>Schváli sa iba pracovná kópia. Zlúčenie do hlavnej vetvy je na tebe.</p>}
          {approval.detail.rationale && <p className="orchestration-review">{approval.detail.rationale}</p>}
          {approval.detail.changes?.map((change) => <div key={change.id}><strong>{change.id}</strong><Diff evidence={change} /></div>)}
          <div className="orchestration-actions">
            <button className="orchestration-primary" type="button" disabled={busy} onClick={() => void action("approve")}>Schváliť</button>
            <button type="button" disabled={busy} onClick={() => void action("deny")}>Zamietnuť</button>
          </div>
        </section>}

        {showRun && snapshot?.result && <ReportView report={snapshot.result} />}
      </div>

      <footer className="orchestrator-dialog-footer">
        {!showRun && <>
          <button type="button" onClick={onClose}>Zrušiť</button>
          <button className="orchestration-primary" type="submit" form={`${titleId}-form`} disabled={busy}>
            {busy ? "Spúšťam…" : "Spustiť orchestrátor"}
          </button>
        </>}
        {showRun && <>
          {running && <button type="button" className="orchestrator-stop" disabled={busy || snapshot?.stage === "stopping"}
            onClick={() => void action("stop")}>STOP</button>}
          {!running && snapshot && COMPLETED_STAGES.has(snapshot.stage) &&
            <button type="button" onClick={() => setView("form")}>Nový beh</button>}
          <button className="orchestration-primary" type="button" onClick={onClose}>Sledovať {viewLabel}</button>
        </>}
      </footer>
    </section>
  </div>;
}
