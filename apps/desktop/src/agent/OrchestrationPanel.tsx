import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type FormEvent } from "react";
import type { ModelCatalog } from "../chat/ModelPicker";

const providers = {
  codex: { label: "OpenAI · Codex", platform: "codex" },
  grok: { label: "xAI · Grok Build", platform: "grok-build" },
  opencode: { label: "OpenCode", platform: "opencode" },
} as const;
type Provider = keyof typeof providers;
type Agent = { provider: Provider; model: string };
type Turn = { text?: string; provider?: Provider; model?: string | null; tokens?: number | null; evidence?: Evidence;
  contextLimit?: number | null; estimatedUsd?: number | null };
type Evidence = { worktree?: string; diff: string; diffCheck: { status: number; output: string } };
type Row = { id: string; status: string; error?: string; result?: Turn };
type PlanItem = { id: string; worker: number; task: string; dependsOn: string[]; files?: string[] };
type Change = Evidence & { id: string };
type Approval = {
  id: number; kind: "workers" | "tests" | "repairs" | "conflicts" | "integration";
  detail: {
    plan?: PlanItem[]; scope?: { base: string | null; files: string[] };
    command?: { executable: string; args: string[] }; changes?: Change[];
    overlaps?: { path: string; tasks: string[] }[]; rationale?: string;
  };
};
type Report = {
  status: string; cleanupConfirmed?: boolean; manager?: Turn; workers?: Row[];
  project?: {
    workspace: string; remainingOverlaps: { path: string; tasks: string[] }[];
    review?: { result?: Turn; reason?: string }; finalReview?: { result?: Turn; reason?: string };
    corrections: Row[]; open: { id: string; reason: string; testExit?: number | string | null }[];
    checks: Record<string, { status: number | string }>;
    correctionChecks?: { checks: Record<string, { status: number | string }> } | null;
    integration?: { status: string; evidence?: Evidence; rationale?: string; reason?: string;
      check?: { status: number | string } | null; review?: Turn } | null;
  };
};
type Snapshot = { id: number; stage: string; approval: Approval | null; result: Report | null; error: string | null };

const initialAgent = (provider: Provider): Agent => ({ provider, model: "" });
const stages: Record<string, string> = {
  starting: "Spúšťam orchestrátor", planning: "Manažér pripravuje plán", working: "Workeri pripravujú návrhy",
  approval: "Čaká sa na schválenie", testing: "Prebiehajú testy", reviewing: "Manažér kontroluje výsledky",
  integrating: "Manažér navrhuje riešenie konfliktov",
  repairing: "Prebieha schválené kolo opráv", stopping: "Zastavujem všetky procesy", cancelled: "Zastavené",
  finished: "Beh skončil", failed: "Beh zlyhal",
};
const completed = new Set(["finished", "cancelled", "failed"]);
const labels: Record<string, string> = {
  proposed: "Návrh pripravený", "needs-repair": "Diff potrebuje opravu", blocked: "Čaká na vyriešenie závislosti",
  cancelled: "Zastavené", failed: "Zlyhalo", "not-approved": "Plán zamietnutý",
  "needs-review": "Výsledky pripravené na kontrolu",
};
const number = new Intl.NumberFormat("sk");
const usd = new Intl.NumberFormat("sk", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const integrationLabels: Record<string, string> = {
  verified: "Schválený kandidát prešiel testom", unverified: "Schválený kandidát čaká na overenie",
  "conflicts-not-approved": "Riešenie konfliktov nebolo schválené",
  "candidate-not-approved": "Spoločný návrh nebol schválený", "diff-failed": "Kontrola spoločného diffu zlyhala",
  "test-failed": "Test spoločnej pracovnej kópie zlyhal", unavailable: "Spoločný návrh sa nepodarilo pripraviť", cancelled: "Zastavené",
};

function AgentFields({ label, agent, models, onChange }: {
  label: string; agent: Agent; models: ModelCatalog | undefined; onChange: (agent: Agent) => void;
}) {
  return <fieldset className="orchestration-agent">
    <legend>{label}</legend>
    <label>Poskytovateľ
      <select value={agent.provider} onChange={(event) => onChange(initialAgent(event.target.value as Provider))}>
        {Object.entries(providers).map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    <label>Model
      <select value={agent.model} onChange={(event) => onChange({ ...agent, model: event.target.value })}>
        <option value="">Predvolený model CLI</option>
        {models?.models.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>
  </fieldset>;
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
  ].filter((turn): turn is Turn & { provider: Provider } => Boolean(turn?.provider));
  return <section className="orchestration-card" aria-labelledby="orchestration-result">
    <h2 id="orchestration-result">{labels[report.status] ?? report.status}</h2>
    {report.cleanupConfirmed && <p>Windows potvrdil ukončenie všetkých procesov behu.</p>}
    {project && <>
      <p className="orchestration-path">{project.workspace}</p>
      {project.remainingOverlaps.length > 0 && <div>
        <h3>Prekrývajúce sa úpravy</h3>
        <ul>{project.remainingOverlaps.map(({ path, tasks }) => <li key={path}>{path} · {tasks.join(", ")}</li>)}</ul>
      </div>}
      {project.open.length > 0 && <div>
        <h3>Otvorené úlohy</h3>
        <ul>{project.open.map(({ id, reason, testExit }) =>
          <li key={id}>{id} · {reason}{testExit != null && <> ({testExit})</>}</li>)}</ul>
      </div>}
      {[...report.workers ?? [], ...project.corrections].map((worker, index) => {
        const correction = index >= (report.workers?.length ?? 0);
        const check = (correction ? project.correctionChecks?.checks : project.checks)?.[worker.id];
        return <div className="orchestration-result-row" key={`${worker.id}-${correction}`}>
          <strong>{worker.id}{correction && " · oprava"}</strong>
          <span>{labels[worker.status] ?? worker.status}</span>
          <span>Výsledok testu · {check?.status === 0 ? "Prešiel" : check?.status ?? "Neznáme"}</span>
          {worker.error && <p>{worker.error}</p>}
          {worker.result?.evidence && <Diff evidence={worker.result.evidence} />}
        </div>;
      })}
      <h3>Posúdenie manažéra</h3>
      <p className="orchestration-review">{review?.result?.text ?? review?.reason ?? "Neznáme"}</p>
      {project.integration && <div>
        <h3>Spoločná pracovná kópia</h3>
        <p>{integrationLabels[project.integration.status] ?? project.integration.status}</p>
        <p className="orchestration-review">{project.integration.rationale || project.integration.reason}</p>
        <p>Výsledok testu · {project.integration.check?.status ?? "Neznáme"}</p>
        {project.integration.evidence && <Diff evidence={project.integration.evidence} />}
      </div>}
    </>}
    <h3>Spotreba</h3>
    {turns.length > 0 ? <ul>{turns.map((turn, index) => <li key={index}>
      {providers[turn.provider].label} · {turn.model ?? "Neznámy model"} · {turn.tokens == null ? "Tokeny neznáme" : `${number.format(turn.tokens)} tokenov`}
      {turn.contextLimit != null && <> · Kontextový limit {number.format(turn.contextLimit)} tokenov</>}
      {turn.estimatedUsd != null && <> · Odhad {usd.format(turn.estimatedUsd)}</>}
    </li>)}</ul> : <p>Tokeny · Neznáme</p>}
    <p>Fakturovaná suma · Neznáme · Limity účtu · Neznáme</p>
  </section>;
}

export function OrchestrationPanel({ visible, sessionName, sessionFolder, onTerminal }: {
  visible: boolean; sessionName?: string; sessionFolder?: string; onTerminal: () => void;
}) {
  const [folder, setFolder] = useState<string>();
  const [files, setFiles] = useState("");
  const [task, setTask] = useState("");
  const [manager, setManager] = useState(initialAgent("codex"));
  const [workers, setWorkers] = useState([initialAgent("codex"), initialAgent("grok")]);
  const [catalogs, setCatalogs] = useState<Partial<Record<Provider, ModelCatalog>>>({});
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [checkExecutable, setCheckExecutable] = useState("");
  const [checkArgs, setCheckArgs] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [error, setError] = useState("");
  const project = folder ?? sessionFolder ?? "";
  const running = Boolean(snapshot && !completed.has(snapshot.stage));

  useEffect(() => {
    if (!visible && !running) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await invoke<Snapshot | null>("orchestration_snapshot");
        if (mounted) setSnapshot(state);
      } catch {
        // Commands show their own errors. Leave the current run visible while polling retries.
      }
      if (mounted) timer = setTimeout(() => void poll(), 550);
    }
    void poll();
    return () => { mounted = false; clearTimeout(timer); };
  }, [visible, running]);

  async function loadModels() {
    setCatalogBusy(true);
    setError("");
    const failures: string[] = [];
    for (const provider of new Set([manager.provider, ...workers.map(({ provider }) => provider)])) {
      try {
        const catalog = await invoke<ModelCatalog>("chat_models", { platform: providers[provider].platform, model: null });
        setCatalogs((previous) => ({ ...previous, [provider]: catalog }));
      } catch (reason) {
        failures.push(`${providers[provider].label} · ${String(reason)}`);
      }
    }
    setError(failures.join("\n"));
    setCatalogBusy(false);
  }

  async function chooseFolder() {
    try {
      const path = await open({ directory: true, multiple: false });
      if (typeof path === "string") setFolder(path);
    } catch (reason) { setError(String(reason)); }
  }

  async function chooseFiles() {
    setError("");
    try {
      const selected = await open({ defaultPath: project.trim(), multiple: true });
      if (!selected) return;
      const prefix = `${project.trim().replace(/\\/g, "/").replace(/\/+$/, "")}/`;
      const paths = (Array.isArray(selected) ? selected : [selected]).map((path) => path.replace(/\\/g, "/"));
      if (paths.some((path) => !path.toLowerCase().startsWith(prefix.toLowerCase()))) {
        setError("Vyber súbory z priečinka projektu alebo z jeho podpriečinkov.");
        return;
      }
      setFiles(paths.map((path) => path.slice(prefix.length)).join("\n"));
    } catch (reason) { setError(String(reason)); }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    setCommandBusy(true);
    setError("");
    try {
      const id = await invoke<number>("orchestration_start", { settings: {
        project, files: files.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), task,
        manager: { ...manager, model: manager.model || null },
        workers: workers.map((worker) => ({ ...worker, model: worker.model || null })),
        check: checkExecutable.trim() ? { executable: checkExecutable.trim(), args: checkArgs ? checkArgs.split(/\r?\n/) : [] } : null,
      } });
      setSnapshot({ id, stage: "starting", approval: null, result: null, error: null });
    } catch (reason) { setError(String(reason)); }
    finally { setCommandBusy(false); }
  }

  async function action(value: "approve" | "deny" | "stop") {
    if (!snapshot) return;
    setCommandBusy(true);
    setError("");
    try {
      await invoke("orchestration_action", { id: snapshot.id, action: value, approvalId: snapshot.approval?.id ?? null });
      setSnapshot(await invoke<Snapshot | null>("orchestration_snapshot"));
    } catch (reason) { setError(String(reason)); }
    finally { setCommandBusy(false); }
  }

  const approval = snapshot?.approval;
  return <main className="orchestrator-workspace" hidden={!visible} aria-labelledby="orchestrator-title">
    <header>
      <span className="workspace-orchestrator-icon" aria-hidden="true" />
      <h1 id="orchestrator-title">Orchestrátor</h1>
      <span className="orchestrator-preview">1.2</span>
    </header>
    <p>{sessionName ?? "Žiadna aktívna relácia"}</p>
    <form hidden={running} onSubmit={(event) => void start(event)}>
      <fieldset className="orchestration-card" disabled={running || commandBusy}>
        <legend>Nový beh</legend>
        <label>Priečinok projektu
          <input value={project} onChange={(event) => setFolder(event.target.value)} placeholder="Absolútna cesta k projektu" required />
        </label>
        <button type="button" onClick={() => void chooseFolder()}>Vybrať priečinok</button>
        <label>Súbory na úpravu · jedna relatívna cesta na riadok
          <textarea value={files} onChange={(event) => setFiles(event.target.value)} placeholder="README.md" rows={3} required />
        </label>
        <button type="button" disabled={!project.trim()} onClick={() => void chooseFiles()}>Vybrať súbory</button>
        <p>Pri výbere koreňa dostupného Git repozitára sa použije posledný commit, ak obsahuje všetky vybrané súbory. V ostatných prípadoch sa použijú vybrané súbory z disku.</p>
        <label>Zadanie pre manažéra
          <textarea value={task} onChange={(event) => setTask(event.target.value)} rows={3} required />
        </label>
        <p>Manažér dostane zadanie a zoznam súborov. Obsah súborov a diffy sa odošlú až po schválení plánu.</p>
        <div className="orchestration-agents">
          <AgentFields label="Manažér" agent={manager} models={catalogs[manager.provider]} onChange={setManager} />
          {workers.map((worker, index) => <AgentFields key={index} label={`Worker ${index + 1}`} agent={worker}
            models={catalogs[worker.provider]} onChange={(agent) => setWorkers((rows) => rows.map((row, i) => i === index ? agent : row))} />)}
        </div>
        <div className="orchestration-actions">
          <button type="button" disabled={catalogBusy} onClick={() => void loadModels()}>{catalogBusy ? "Načítavam modely…" : "Načítať modely CLI"}</button>
          <button type="button" disabled={workers.length === 8} onClick={() => setWorkers([...workers, initialAgent("codex")])}>Pridať workera</button>
          <button type="button" disabled={workers.length === 2} onClick={() => setWorkers(workers.slice(0, -1))}>Odobrať posledného</button>
        </div>
        <details>
          <summary>Voliteľný testovací príkaz</summary>
          <label>Absolútna cesta k testovaciemu programu (.exe)
            <input value={checkExecutable} onChange={(event) => setCheckExecutable(event.target.value)} />
          </label>
          <label>Argumenty · jeden na riadok
            <textarea value={checkArgs} onChange={(event) => setCheckArgs(event.target.value)} rows={2} />
          </label>
        </details>
        <div className="orchestration-actions">
          <button className="orchestration-primary" type="submit" disabled={!project || !files.trim() || !task.trim()}>Pripraviť plán</button>
          <button type="button" onClick={onTerminal}>Prejsť do terminálu</button>
        </div>
      </fieldset>
    </form>
    {(snapshot || error) && <section className="orchestration-card" aria-label="Stav behu">
      <p role="status">{snapshot && stages[snapshot.stage]}</p>
      {(snapshot?.error || error) && <p className="orchestration-review" role="alert">{error || snapshot?.error}</p>}
      {running && <button type="button" onClick={() => void action("stop")} disabled={commandBusy || snapshot?.stage === "stopping"}>STOP</button>}
    </section>}
    {approval && <section className="orchestration-card" aria-labelledby="orchestration-approval">
      <h2 id="orchestration-approval">{{ workers: "Schváliť plán a zdieľanie súborov", tests: "Schváliť spustenie testov",
        repairs: "Schváliť jedno kolo opráv", conflicts: "Schváliť riešenie prekrývajúcich sa úprav",
        integration: "Schváliť spoločnú pracovnú kópiu" }[approval.kind]}</h2>
      {approval.detail.scope && <p>{approval.detail.scope.base
        ? `Commit ${approval.detail.scope.base}`
        : "Vybrané súbory z disku sa spracujú v oddelenej pracovnej kópii."}</p>}
      {approval.detail.plan && <ol>{approval.detail.plan.map((entry) => <li key={entry.id}>
        <strong>{entry.id} · Worker {entry.worker + 1}</strong>
        {workers[entry.worker] && <p>{providers[workers[entry.worker].provider].label} · {workers[entry.worker].model || "Predvolený model CLI"}</p>}
        <p>{entry.task}</p><p>{entry.files?.join(", ")}{entry.dependsOn.length > 0 && ` · Po úlohách ${entry.dependsOn.join(", ")}`}</p>
      </li>)}</ol>}
      {approval.detail.command && <>
        <p>Príkaz sa spustí s oprávneniami tvojho účtu v testovacích kópiách.</p>
        <pre>{JSON.stringify(approval.detail.command, null, 2)}</pre>
      </>}
      {approval.detail.overlaps && <>
        <p>Manažér dostane úplný obsah uvedených súborov z pôvodného commitu a návrhy workerov.</p>
        <ul>{approval.detail.overlaps.map(({ path, tasks }) => <li key={path}>{path} · {tasks.join(", ")}</li>)}</ul>
      </>}
      {approval.kind === "integration" && <p>Schváli sa iba pracovná kópia. Zlúčenie do hlavnej vetvy je na tebe.</p>}
      {approval.detail.rationale && <p className="orchestration-review">{approval.detail.rationale}</p>}
      {approval.detail.changes?.map((change) => <div key={change.id}><strong>{change.id}</strong><Diff evidence={change} /></div>)}
      <div className="orchestration-actions">
        <button className="orchestration-primary" type="button" disabled={commandBusy} onClick={() => void action("approve")}>Schváliť</button>
        <button type="button" disabled={commandBusy} onClick={() => void action("deny")}>Zamietnuť</button>
      </div>
    </section>}
    {snapshot?.result && <ReportView report={snapshot.result} />}
  </main>;
}
