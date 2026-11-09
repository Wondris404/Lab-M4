// Activity events streamed from the orchestrator core (packages/orchestrator-core,
// `onEvent`) and their presentation in the terminal pane and in chat mode.
import { agentLabel, MANAGER_COLOR, providerInfo } from "./orchestratorProviders";

export interface EventAgent {
  provider: string;
  model: string | null;
}

interface Base { at?: number }
export type OrchestratorEvent = Base & (
  | { type: "run-start"; task: string; manager: EventAgent; workers: EventAgent[] }
  | { type: "manager-planning"; manager: EventAgent }
  | { type: "plan"; tokens?: number | null; tasks: PlanTask[] }
  | { type: "approval-wait"; kind: string }
  | { type: "stage"; stage: string }
  | { type: "worker-start"; task: string; worker: number; agent: EventAgent; correction: boolean; summary?: string }
  | {
    type: "worker-done"; task: string; worker: number; agent: EventAgent; correction: boolean; status: string;
    tokens?: number | null; error?: string | null; changed?: string[]; added?: number; removed?: number;
    diffCheck?: number | null;
  }
  | { type: "worker-blocked"; task: string; worker: number; agent: EventAgent; dependsOn: string[] }
  | { type: "test-result"; task: string; status: number | string | null }
  | { type: "review-start"; manager: EventAgent; final: boolean }
  | { type: "review-done"; manager: EventAgent; final: boolean; summary: string; repairs: string[]; tokens?: number | null }
  | { type: "review-failed"; manager: EventAgent; final: boolean; reason: string }
  | { type: "integration"; status: string }
  | { type: "done"; status: string; open?: number }
  | { type: "failed"; reason: string }
);

export interface PlanTask {
  id: string;
  worker: number;
  task: string;
  dependsOn: string[];
  files?: string[];
  reason?: string | null;
  agent: EventAgent;
}

export type ActivityTone = "info" | "progress" | "success" | "warning" | "error" | "muted";
export type ActivityRole = "manager" | "worker" | "system";

export interface ActivityEntry {
  at: number | null;
  role: ActivityRole;
  /** Short column tag: "ORCH", "W1"…"W8" or "LAB-M4". */
  tag: string;
  agent: EventAgent | null;
  tone: ActivityTone;
  icon: string;
  text: string;
  details: string[];
}

export const STAGE_LABELS: Record<string, string> = {
  starting: "Spúšťam orchestrátor", planning: "Orchestrátor pripravuje plán", working: "Workeri pracujú",
  approval: "Čaká sa na schválenie", testing: "Prebiehajú testy", reviewing: "Orchestrátor kontroluje výsledky",
  integrating: "Orchestrátor rieši prekrývajúce sa úpravy", repairing: "Prebieha kolo opráv",
  stopping: "Zastavujem všetky procesy", cancelled: "Zastavené", finished: "Beh skončil", failed: "Beh zlyhal",
};

const APPROVAL_LABELS: Record<string, string> = {
  workers: "plán a zdieľanie súborov", tests: "spustenie testov", repairs: "kolo opráv",
  conflicts: "riešenie prekrývajúcich sa úprav", integration: "spoločnú pracovnú kópiu",
};

const INTEGRATION_LABELS: Record<string, [ActivityTone, string]> = {
  verified: ["success", "Spoločná pracovná kópia prešla testom"],
  unverified: ["info", "Spoločná pracovná kópia je pripravená, test nebežal"],
  "conflicts-not-approved": ["muted", "Riešenie konfliktov nebolo schválené"],
  "candidate-not-approved": ["muted", "Spoločný návrh nebol schválený"],
  "diff-failed": ["error", "Kontrola spoločného diffu zlyhala"],
  "test-failed": ["error", "Test spoločnej pracovnej kópie zlyhal"],
  unavailable: ["error", "Spoločný návrh sa nepodarilo pripraviť"],
  cancelled: ["muted", "Integrácia zastavená"],
};

const DONE_LABELS: Record<string, [ActivityTone, string]> = {
  "needs-review": ["success", "Beh skončil · výsledky sú pripravené na tvoju kontrolu"],
  proposed: ["success", "Beh skončil · všetky návrhy sú pripravené"],
  incomplete: ["warning", "Beh skončil · niektoré úlohy sa nedokončili"],
  "not-approved": ["muted", "Plán bol zamietnutý, workeri sa nespustili"],
  cancelled: ["muted", "Beh bol zastavený"],
};

const number = new Intl.NumberFormat("sk");

/** Model and CLI output is data: strip control characters so it can never drive the terminal. */
export function sanitize(text: unknown, limit = 600): string {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

const workerTag = (index: number) => `W${Number.isInteger(index) && index >= 0 ? index + 1 : "?"}`;
const tokens = (value: number | null | undefined) => value == null ? "" : ` · ${number.format(value)} tokenov`;
const plural = (count: number, one: string, few: string, many: string) =>
  `${count} ${count === 1 ? one : count >= 2 && count <= 4 ? few : many}`;

function entry(event: OrchestratorEvent, partial: Omit<ActivityEntry, "at" | "details"> & { details?: string[] }): ActivityEntry {
  return { at: typeof event.at === "number" ? event.at : null, details: [], ...partial };
}

/** Turn one core event into a readable, presentation-neutral activity entry. */
export function describeEvent(event: OrchestratorEvent): ActivityEntry {
  const system = { role: "system" as const, tag: "LAB-M4", agent: null };
  switch (event.type) {
    case "run-start": {
      const vendors = [...new Set(event.workers.map(({ provider }) => providerInfo(provider).company))];
      return entry(event, {
        ...system, tone: "info", icon: "●",
        text: `Nový beh · orchestrátor ${agentLabel(event.manager)} · ${plural(event.workers.length, "AI worker", "AI workeri", "AI workerov")} (${vendors.join(", ")})`,
        details: [`Zadanie: ${sanitize(event.task, 400)}`,
          ...event.workers.map((agent, index) => `${workerTag(index)} ${agentLabel(agent)}`)],
      });
    }
    case "manager-planning":
      return entry(event, { role: "manager", tag: "ORCH", agent: event.manager, tone: "progress", icon: "…",
        text: "Pripravujem plán a vyberám najvhodnejšiu AI pre každú úlohu" });
    case "plan":
      return entry(event, {
        role: "manager", tag: "ORCH", agent: null, tone: "info", icon: "≡",
        text: `Plán: ${plural(event.tasks.length, "úloha", "úlohy", "úloh")}${tokens(event.tokens)}`,
        details: event.tasks.flatMap((task) => [
          `${sanitize(task.id, 40)} → ${workerTag(task.worker)} ${agentLabel(task.agent)}: ${sanitize(task.task, 200)}` +
            (task.dependsOn.length ? ` (po: ${task.dependsOn.map((id) => sanitize(id, 40)).join(", ")})` : ""),
          ...(task.reason ? [`   prečo: ${sanitize(task.reason, 300)}`] : []),
        ]),
      });
    case "approval-wait":
      return entry(event, { ...system, tone: "warning", icon: "‖",
        text: `Čaká na tvoje schválenie: ${APPROVAL_LABELS[event.kind] ?? sanitize(event.kind, 40)}` });
    case "stage":
      return entry(event, { ...system, tone: "muted", icon: "·",
        text: `Fáza: ${STAGE_LABELS[event.stage] ?? sanitize(event.stage, 40)}` });
    case "worker-start":
      return entry(event, {
        role: "worker", tag: workerTag(event.worker), agent: event.agent, tone: "progress", icon: "▶",
        text: `${event.correction ? "Opravujem" : "Začínam"} úlohu ${sanitize(event.task, 40)}` +
          (event.summary ? `: ${sanitize(event.summary, 200)}` : ""),
      });
    case "worker-done": {
      const base = { role: "worker" as const, tag: workerTag(event.worker), agent: event.agent };
      const files = event.changed?.length ? event.changed.map((path) => sanitize(path, 120)).join(", ") : "bez zmien súborov";
      const stats = event.added != null || event.removed != null ? ` · +${event.added ?? 0} −${event.removed ?? 0}` : "";
      const task = sanitize(event.task, 40);
      if (event.status === "proposed")
        return entry(event, { ...base, tone: "success", icon: "✓",
          text: `${event.correction ? "Oprava" : "Návrh"} ${task} hotový · ${files}${stats}${tokens(event.tokens)}` });
      if (event.status === "needs-repair")
        return entry(event, { ...base, tone: "warning", icon: "!",
          text: `Návrh ${task} potrebuje opravu (git diff --check zlyhal) · ${files}${stats}` });
      if (event.status === "cancelled")
        return entry(event, { ...base, tone: "muted", icon: "■", text: `Úloha ${task} zastavená` });
      return entry(event, { ...base, tone: "error", icon: "✗",
        text: `Úloha ${task} zlyhala${event.error ? `: ${sanitize(event.error, 300)}` : ""}` });
    }
    case "worker-blocked":
      return entry(event, { role: "worker", tag: workerTag(event.worker), agent: event.agent, tone: "muted", icon: "‖",
        text: `Úloha ${sanitize(event.task, 40)} sa nespustí · závislosť ${event.dependsOn.map((id) => sanitize(id, 40)).join(", ")} neprešla` });
    case "test-result":
      return event.status === 0
        ? entry(event, { ...system, tone: "success", icon: "✓", text: `Test úlohy ${sanitize(event.task, 40)} prešiel` })
        : entry(event, { ...system, tone: "error", icon: "✗",
          text: `Test úlohy ${sanitize(event.task, 40)} zlyhal (${sanitize(String(event.status ?? "neznámy výsledok"), 40)})` });
    case "review-start":
      return entry(event, { role: "manager", tag: "ORCH", agent: event.manager, tone: "progress", icon: "…",
        text: event.final ? "Záverečná kontrola po opravách" : "Kontrolujem diffy a výsledky workerov" });
    case "review-done":
      return entry(event, {
        role: "manager", tag: "ORCH", agent: event.manager, tone: "info", icon: "✎",
        text: `${event.final ? "Záverečné posúdenie" : "Posúdenie"}: ${sanitize(event.summary, 600) || "bez zhrnutia"}`,
        details: event.repairs.length ? [`Na opravu: ${event.repairs.map((id) => sanitize(id, 40)).join(", ")}`] : [],
      });
    case "review-failed":
      return entry(event, { role: "manager", tag: "ORCH", agent: event.manager, tone: "error", icon: "✗",
        text: `Kontrola zlyhala: ${sanitize(event.reason, 300)}` });
    case "integration": {
      const [tone, text] = INTEGRATION_LABELS[event.status] ?? ["info", `Integrácia: ${sanitize(event.status, 40)}`];
      return entry(event, { role: "manager", tag: "ORCH", agent: null, tone, icon: tone === "success" ? "✓" : "◆", text });
    }
    case "done": {
      const [tone, text] = DONE_LABELS[event.status] ?? ["info", `Beh skončil · ${sanitize(event.status, 40)}`];
      return entry(event, { ...system, tone, icon: tone === "success" ? "✔" : "■", text,
        details: event.open ? [`Otvorené úlohy: ${event.open}`] : [] });
    }
    case "failed":
      return entry(event, { ...system, tone: "error", icon: "✗", text: `Beh zlyhal: ${sanitize(event.reason, 400)}` });
    default: {
      const unknown = event as { type?: unknown };
      return entry(event, { ...system, tone: "muted", icon: "·", text: `Udalosť ${sanitize(String(unknown.type), 40)}` });
    }
  }
}

export function formatTime(at: number | null): string {
  if (at == null) return "--:--:--";
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

const rgb = ([r, g, b]: readonly [number, number, number]) => `\x1b[38;2;${r};${g};${b}m`;
const TONE_ANSI: Record<ActivityTone, string> = {
  info: "", progress: "\x1b[36m", success: "\x1b[32m", warning: "\x1b[33m", error: "\x1b[31m", muted: "\x1b[2m",
};
const RESET = "\x1b[0m";

export function entryColor(entry: ActivityEntry): readonly [number, number, number] | null {
  if (entry.role === "manager") return MANAGER_COLOR;
  if (entry.agent) return providerInfo(entry.agent.provider).color;
  return null;
}

/**
 * ANSI text for the read-only activity terminal: `time TAG agent  icon text`, details
 * indented below. Lines end with CRLF as xterm expects.
 */
export function formatTerminalEntry(entry: ActivityEntry, options: { time?: (at: number | null) => string } = {}): string {
  const time = (options.time ?? formatTime)(entry.at);
  const color = entryColor(entry);
  const paint = (text: string) => color ? `${rgb(color)}${text}${RESET}` : text;
  const tag = paint(`\x1b[1m${entry.tag.padEnd(6)}`);
  const agent = entry.agent ? ` ${paint(agentLabel(entry.agent))}` : "";
  const tone = TONE_ANSI[entry.tone];
  const body = `${tone}${entry.icon} ${entry.text}${tone ? RESET : ""}`;
  const indent = " ".repeat(time.length + 8);
  const details = entry.details.map((line) => `${indent}\x1b[2m│\x1b[0m ${line}\r\n`).join("");
  return `\x1b[2m${time}${RESET} ${tag}${RESET}${agent} ${body}\r\n${details}`;
}

export type AgentState = "waiting" | "planning" | "working" | "repairing" | "reviewing" | "done" | "needs-repair" | "failed" | "idle";

export interface AgentStatus {
  key: string;
  tag: string;
  role: "manager" | "worker";
  agent: EventAgent;
  state: AgentState;
  task: string | null;
}

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  waiting: "čaká", planning: "plánuje", working: "pracuje", repairing: "opravuje", reviewing: "kontroluje",
  done: "hotovo", "needs-repair": "na opravu", failed: "zlyhal", idle: "voľný",
};

/** Live per-agent status for the legend above the activity log (supports concurrent workers). */
export function summarizeAgents(events: readonly OrchestratorEvent[]): AgentStatus[] {
  const agents = new Map<string, AgentStatus>();
  const busy = new Map<string, Set<string>>();
  const set = (key: string, patch: Partial<AgentStatus>) => {
    const current = agents.get(key);
    if (current) agents.set(key, { ...current, ...patch });
  };
  for (const event of events) {
    switch (event.type) {
      case "run-start":
        agents.clear();
        busy.clear();
        agents.set("manager", { key: "manager", tag: "ORCH", role: "manager", agent: event.manager, state: "waiting", task: null });
        event.workers.forEach((agent, index) => agents.set(`w${index}`,
          { key: `w${index}`, tag: workerTag(index), role: "worker", agent, state: "idle", task: null }));
        break;
      case "manager-planning": set("manager", { state: "planning" }); break;
      case "plan": set("manager", { state: "waiting" }); break;
      case "review-start": set("manager", { state: "reviewing" }); break;
      case "review-done": case "review-failed": set("manager", { state: "waiting" }); break;
      case "worker-start": {
        const key = `w${event.worker}`;
        const tasks = busy.get(key) ?? new Set<string>();
        tasks.add(event.task);
        busy.set(key, tasks);
        set(key, { state: event.correction ? "repairing" : "working", task: event.task });
        break;
      }
      case "worker-done": {
        const key = `w${event.worker}`;
        const tasks = busy.get(key);
        tasks?.delete(event.task);
        const state: AgentState = event.status === "proposed" ? "done" : event.status === "needs-repair"
          ? "needs-repair" : event.status === "cancelled" ? "idle" : "failed";
        if (tasks?.size) set(key, { task: [...tasks].at(-1) ?? null });
        else set(key, { state, task: event.task });
        break;
      }
      case "done": case "failed":
        set("manager", { state: event.type === "failed" ? "failed" : "done" });
        break;
      default:
        break;
    }
  }
  return [...agents.values()];
}

/** Text for the screen-reader live region (no ANSI, no details). */
export function announce(entry: ActivityEntry): string {
  const who = entry.agent ? `${entry.tag} ${agentLabel(entry.agent)}` : entry.tag;
  return `${who}: ${entry.text}`;
}
