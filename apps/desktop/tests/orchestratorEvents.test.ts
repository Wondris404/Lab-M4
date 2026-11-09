import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
// The deterministic simulation drives the real orchestrator core with scripted agents.
import { runSimulatedSession } from "../../../packages/orchestrator-core/testing/simulated-run.mjs";
import {
  announce,
  describeEvent,
  formatTerminalEntry,
  sanitize,
  summarizeAgents,
  type OrchestratorEvent,
} from "../src/agent/orchestratorEvents";
import { EMPTY_EVENTS, mergeEvents, type Snapshot } from "../src/agent/useOrchestrationRun";

const codex = { provider: "codex", model: "gpt-x" };
const grok = { provider: "grok", model: "grok-y" };
const opencode = { provider: "opencode", model: null };
const fixedTime = () => "12:00:00";
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("activity entries", () => {
  test("plan shows which worker and model got each task and why", () => {
    const entry = describeEvent({ type: "plan", tokens: 1200, tasks: [
      { id: "api", worker: 1, task: "Design API", dependsOn: [], agent: grok, reason: "Fast at API sketches" },
      { id: "docs", worker: 2, task: "Docs", dependsOn: ["api"], agent: opencode, reason: null },
    ] });
    expect(entry.role).toBe("manager");
    expect(entry.tag).toBe("ORCH");
    expect(entry.text).toBe("Plán: 2 úlohy · 1\u00a0200 tokenov");
    expect(entry.details).toEqual([
      "api → W2 Grok Build · grok-y: Design API",
      "   prečo: Fast at API sketches",
      "docs → W3 OpenCode · predvolený model: Docs (po: api)",
    ]);
  });

  test("worker results summarize files, diff size and status", () => {
    const done = describeEvent({ type: "worker-done", task: "theme", worker: 0, agent: codex, correction: false,
      status: "proposed", tokens: 900, changed: ["src/theme.ts"], added: 3, removed: 1, diffCheck: 0 });
    expect(done).toMatchObject({ tone: "success", tag: "W1", icon: "✓" });
    expect(done.text).toBe("Návrh theme hotový · src/theme.ts · +3 −1 · 900 tokenov");
    const repair = describeEvent({ type: "worker-done", task: "toggle", worker: 1, agent: grok, correction: false,
      status: "needs-repair", changed: ["a.tsx"], added: 2, removed: 0, diffCheck: 1 });
    expect(repair.tone).toBe("warning");
    expect(repair.text).toContain("potrebuje opravu");
    const failed = describeEvent({ type: "worker-done", task: "x", worker: 2, agent: opencode, correction: false,
      status: "failed", error: "CLI crashed" });
    expect(failed).toMatchObject({ tone: "error", text: "Úloha x zlyhala: CLI crashed" });
    const fixed = describeEvent({ type: "worker-done", task: "toggle", worker: 1, agent: grok, correction: true,
      status: "proposed", changed: [], added: 0, removed: 0 });
    expect(fixed.text).toMatch(/^Oprava toggle hotový · bez zmien súborov/);
  });

  test("approval waits, reviews, integration and the end of the run are explicit", () => {
    expect(describeEvent({ type: "approval-wait", kind: "workers" }).text).toBe("Čaká na tvoje schválenie: plán a zdieľanie súborov");
    const review = describeEvent({ type: "review-done", manager: codex, final: false, summary: "Fix toggle", repairs: ["toggle"] });
    expect(review).toMatchObject({ text: "Posúdenie: Fix toggle", details: ["Na opravu: toggle"] });
    expect(describeEvent({ type: "integration", status: "verified" }).tone).toBe("success");
    expect(describeEvent({ type: "done", status: "needs-review", open: 2 }).details).toEqual(["Otvorené úlohy: 2"]);
    expect(describeEvent({ type: "failed", reason: "boom" })).toMatchObject({ tone: "error", text: "Beh zlyhal: boom" });
    expect(describeEvent({ type: "mystery" } as unknown as OrchestratorEvent).text).toBe("Udalosť mystery");
  });

  test("model output can never inject terminal control sequences", () => {
    const evil = "ok\x1b]0;pwned\x07\x1b[2J\r\nnext\u009b31m";
    expect(sanitize(evil)).toBe("ok ]0;pwned [2J next 31m");
    const line = formatTerminalEntry(describeEvent({ type: "review-done", manager: codex, final: true, summary: evil, repairs: [] }), { time: fixedTime });
    // Only the formatter's own SGR color sequences remain.
    expect(line.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
    expect(sanitize("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("terminal formatting", () => {
  test("lines carry time, agent tag, vendor color and model label and end with CRLF", () => {
    const text = formatTerminalEntry(describeEvent({ type: "worker-start", task: "toggle", worker: 1, agent: grok,
      correction: false, summary: "Build the toggle", at: 0 }), { time: fixedTime });
    expect(text).toContain("\x1b[38;2;96;165;250m");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(stripAnsi(text)).toBe("12:00:00 W2     Grok Build · grok-y ▶ Začínam úlohu toggle: Build the toggle\r\n");
  });

  test("details are indented under the entry and the orchestrator has its own color", () => {
    const text = formatTerminalEntry(describeEvent({ type: "plan", tasks: [
      { id: "a", worker: 0, task: "A", dependsOn: [], agent: codex, reason: "why" },
    ] }), { time: fixedTime });
    const lines = stripAnsi(text).split("\r\n");
    expect(lines[0]).toBe("12:00:00 ORCH   ≡ Plán: 1 úloha");
    expect(lines[1]).toBe(`${" ".repeat(16)}│ a → W1 Codex · gpt-x: A`);
    expect(lines[2]).toBe(`${" ".repeat(16)}│    prečo: why`);
    expect(text).toContain("\x1b[38;2;200;140;255m");
  });

  test("screen reader announcement is plain text", () => {
    expect(announce(describeEvent({ type: "worker-start", task: "t", worker: 0, agent: codex, correction: true })))
      .toBe("W1 Codex · gpt-x: Opravujem úlohu t");
  });
});

describe("agent legend", () => {
  test("tracks concurrent workers from different vendors", () => {
    const events: OrchestratorEvent[] = [
      { type: "run-start", task: "x", manager: codex, workers: [codex, grok, opencode] },
      { type: "manager-planning", manager: codex },
      { type: "worker-start", task: "a", worker: 0, agent: codex, correction: false },
      { type: "worker-start", task: "b", worker: 1, agent: grok, correction: false },
      { type: "worker-start", task: "c", worker: 2, agent: opencode, correction: false },
    ];
    const working = summarizeAgents(events);
    expect(working.map(({ tag, state }) => `${tag}:${state}`)).toEqual(["ORCH:planning", "W1:working", "W2:working", "W3:working"]);
    const later = summarizeAgents([...events,
      { type: "worker-done", task: "b", worker: 1, agent: grok, correction: false, status: "needs-repair" },
      { type: "worker-done", task: "c", worker: 2, agent: opencode, correction: false, status: "proposed" },
      { type: "review-start", manager: codex, final: false },
      { type: "worker-start", task: "b", worker: 1, agent: grok, correction: true },
    ]);
    expect(later.map(({ tag, state }) => `${tag}:${state}`)).toEqual(["ORCH:reviewing", "W1:working", "W2:repairing", "W3:done"]);
  });

  test("a worker running two tasks stays busy until both finish", () => {
    const status = summarizeAgents([
      { type: "run-start", task: "x", manager: codex, workers: [codex, grok] },
      { type: "worker-start", task: "a", worker: 1, agent: grok, correction: false },
      { type: "worker-start", task: "b", worker: 1, agent: grok, correction: false },
      { type: "worker-done", task: "a", worker: 1, agent: grok, correction: false, status: "proposed" },
    ]);
    expect(status[2]).toMatchObject({ state: "working", task: "b" });
  });
});

describe("event stream merging", () => {
  const snap = (patch: Partial<Snapshot>): Snapshot => ({ id: 1, stage: "working", approval: null, result: null, error: null, ...patch });
  const ev = (stage: string): OrchestratorEvent => ({ type: "stage", stage });

  test("appends only unseen events and ignores overlapping windows", () => {
    let state = mergeEvents(EMPTY_EVENTS, snap({ eventStart: 0, eventTotal: 2, events: [ev("a"), ev("b")] }));
    expect(state).toMatchObject({ runId: 1, next: 2 });
    state = mergeEvents(state, snap({ eventStart: 1, eventTotal: 3, events: [ev("b"), ev("c")] }));
    expect(state.items.map((event) => event.type === "stage" && event.stage)).toEqual(["a", "b", "c"]);
    expect(state.next).toBe(3);
    expect(mergeEvents(state, snap({ eventStart: 3, eventTotal: 3, events: [] }))).toBe(state);
  });

  test("a new run starts a fresh log and evicted events are flagged", () => {
    const first = mergeEvents(EMPTY_EVENTS, snap({ eventStart: 0, eventTotal: 1, events: [ev("a")] }));
    const stale = mergeEvents(first, snap({ id: 2, eventStart: 1, eventTotal: 1, events: [] }));
    expect(stale).toEqual({ runId: 2, next: 0, truncated: false, items: [] });
    const fresh = mergeEvents(stale, snap({ id: 2, eventStart: 0, eventTotal: 1, events: [ev("x")] }));
    expect(fresh.items).toHaveLength(1);
    const gap = mergeEvents(fresh, snap({ id: 2, eventStart: 5, eventTotal: 6, events: [ev("y")] }));
    expect(gap).toMatchObject({ truncated: true, next: 6 });
    expect(mergeEvents(gap, null)).toBe(gap);
  });
});

describe("simulated multi-agent run end to end", () => {
  test("every event from the real core renders as readable text", async () => {
    const root = resolve(".lab-m4/test-tmp/desktop-events");
    mkdirSync(root, { recursive: true });
    const { events, project } = await runSimulatedSession({ speed: 0.1, root });
    try {
      const entries = (events as OrchestratorEvent[]).map(describeEvent);
      expect(entries.every(({ text }) => !text.startsWith("Udalosť"))).toBe(true);
      const terminal = entries.map((entry) => stripAnsi(formatTerminalEntry(entry, { time: fixedTime }))).join("");
      for (const label of ["Codex · sim-codex-worker", "Grok Build · sim-grok-worker", "OpenCode · sim-opencode-worker"])
        expect(terminal).toContain(label);
      expect(terminal).toContain("prečo:");
      expect(terminal).toContain("potrebuje opravu");
      expect(terminal).toContain("Opravujem úlohu toggle");
      expect(terminal).toContain("Spoločná pracovná kópia prešla testom");
      expect(summarizeAgents(events as OrchestratorEvent[]).every(({ state }) => !["working", "repairing"].includes(state))).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
