import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestratorEvent } from "./orchestratorEvents";

export interface Evidence { worktree?: string; diff: string; diffCheck: { status: number; output: string } }
export interface Turn {
  text?: string; provider?: string; model?: string | null; tokens?: number | null; evidence?: Evidence;
  contextLimit?: number | null; estimatedUsd?: number | null;
}
export interface Row { id: string; status: string; error?: string; result?: Turn }
export interface PlanItem { id: string; worker: number; task: string; dependsOn: string[]; files?: string[]; reason?: string }
export type Change = Evidence & { id: string };
export interface Approval {
  id: number; kind: "workers" | "tests" | "repairs" | "conflicts" | "integration";
  detail: {
    plan?: PlanItem[]; scope?: { base: string | null; files: string[] };
    command?: { executable: string; args: string[] }; changes?: Change[];
    overlaps?: { path: string; tasks: string[] }[]; rationale?: string;
  };
}
export interface Report {
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
}
export interface Snapshot {
  id: number; stage: string; approval: Approval | null; result: Report | null; error: string | null;
  eventStart?: number; eventTotal?: number; events?: OrchestratorEvent[];
}

export interface StartSettings {
  project: string; files: string[]; task: string;
  manager: { provider: string; model: string | null };
  workers: { provider: string; model: string | null }[];
  check: { executable: string; args: string[] } | null;
}

export const COMPLETED_STAGES = new Set(["finished", "cancelled", "failed"]);
const POLL_MS = 550;
const MAX_CLIENT_EVENTS = 4000;

export interface RunEvents {
  runId: number | null;
  /** Absolute index of the next event to request. */
  next: number;
  /** True when older events were evicted by the backend before the client saw them. */
  truncated: boolean;
  items: OrchestratorEvent[];
}

export const EMPTY_EVENTS: RunEvents = { runId: null, next: 0, truncated: false, items: [] };

/** Merge one snapshot's event window into the client log (pure; unit tested). */
export function mergeEvents(previous: RunEvents, snapshot: Snapshot | null): RunEvents {
  if (!snapshot) return previous;
  const incoming = snapshot.events ?? [];
  const start = snapshot.eventStart ?? (snapshot.id === previous.runId ? previous.next : 0);
  // A different run whose window was requested with a stale index: restart from zero next poll.
  if (snapshot.id !== previous.runId && previous.next > 0 && start > 0) return { ...EMPTY_EVENTS, runId: snapshot.id };
  const base = snapshot.id === previous.runId ? previous : { ...EMPTY_EVENTS, runId: snapshot.id };
  if (!incoming.length) {
    if (base === previous && (snapshot.eventTotal ?? base.next) <= base.next) return previous;
    return { ...base, next: Math.max(base.next, snapshot.eventTotal ?? base.next) };
  }
  // Drop anything already seen (overlapping windows after a retry).
  const fresh = incoming.slice(Math.max(0, base.next - start));
  const gap = start > base.next;
  const items = [...base.items, ...fresh];
  return {
    runId: snapshot.id,
    next: start + incoming.length,
    truncated: base.truncated || gap || items.length > MAX_CLIENT_EVENTS,
    items: items.length > MAX_CLIENT_EVENTS ? items.slice(-MAX_CLIENT_EVENTS) : items,
  };
}

/**
 * Shared orchestrator run state: polls the backend while the window is open or a run is
 * active, and accumulates the activity events for the terminal / chat views.
 */
export function useOrchestrationRun(watching: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<RunEvents>(EMPTY_EVENTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const running = Boolean(snapshot && !COMPLETED_STAGES.has(snapshot.stage));

  const apply = useCallback((state: Snapshot | null) => {
    setSnapshot(state);
    setEvents((previous) => {
      const merged = mergeEvents(previous, state);
      eventsRef.current = merged;
      return merged;
    });
  }, []);

  const fetchSnapshot = useCallback(async () => {
    const current = eventsRef.current;
    return invoke<Snapshot | null>("orchestration_snapshot", { since: current.next });
  }, []);

  useEffect(() => {
    if (!watching && !running) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await fetchSnapshot();
        if (mounted) apply(state);
      } catch {
        // Commands show their own errors; keep the current run visible while polling retries.
      }
      if (mounted) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => { mounted = false; clearTimeout(timer); };
  }, [watching, running, apply, fetchSnapshot]);

  const start = useCallback(async (settings: StartSettings) => {
    setBusy(true);
    setError("");
    try {
      const id = await invoke<number>("orchestration_start", { settings });
      eventsRef.current = { ...EMPTY_EVENTS, runId: id };
      setEvents(eventsRef.current);
      setSnapshot({ id, stage: "starting", approval: null, result: null, error: null });
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const action = useCallback(async (value: "approve" | "deny" | "stop") => {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      await invoke("orchestration_action", { id: snapshot.id, action: value, approvalId: snapshot.approval?.id ?? null });
      apply(await fetchSnapshot());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [snapshot, apply, fetchSnapshot]);

  return { snapshot, events, running, busy, error, setError, start, action };
}

export type OrchestrationRun = ReturnType<typeof useOrchestrationRun>;
