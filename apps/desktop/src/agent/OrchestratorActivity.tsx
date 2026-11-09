import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { XtermThemeColors } from "../settings/themes";
import {
  AGENT_STATE_LABELS,
  announce,
  describeEvent,
  entryColor,
  formatTerminalEntry,
  formatTime,
  STAGE_LABELS,
  summarizeAgents,
  type ActivityEntry,
} from "./orchestratorEvents";
import { agentLabel, MANAGER_COLOR, providerInfo } from "./orchestratorProviders";
import type { OrchestrationRun } from "./useOrchestrationRun";

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 300;
const KEYBOARD_STEP = 24;
const rgb = (color: readonly [number, number, number] | null) => color ? `rgb(${color.join(" ")})` : "var(--text-dim)";

/** Read-only xterm that renders formatted agent activity, styled like the session terminals. */
function ActivityTerminal({ entries, runId, truncated, theme, fontFamily, fontSize }: {
  entries: ActivityEntry[]; runId: number | null; truncated: boolean;
  theme: XtermThemeColors; fontFamily: string; fontSize: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const written = useRef<{ runId: number | null; count: number; truncated: boolean }>({ runId: null, count: 0, truncated: false });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      disableStdin: true, cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "none",
      scrollback: 5000, fontFamily, fontSize, theme, convertEol: false,
      screenReaderMode: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    term.write("\x1b[?25l");
    termRef.current = { term, fit };
    const refit = () => { try { fit.fit(); } catch { /* Hidden while measuring. */ } };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      written.current = { runId: null, count: 0, truncated: false };
    };
    // Created once; appearance updates are applied by the next effect.
  }, []);

  useEffect(() => {
    const current = termRef.current;
    if (!current) return;
    current.term.options.theme = theme;
    current.term.options.fontFamily = fontFamily;
    current.term.options.fontSize = fontSize;
    try { current.fit.fit(); } catch { /* Hidden. */ }
  }, [theme, fontFamily, fontSize]);

  useEffect(() => {
    const current = termRef.current;
    if (!current) return;
    const state = written.current;
    if (state.runId !== runId || entries.length < state.count) {
      current.term.reset();
      current.term.write("\x1b[?25l");
      written.current = { runId, count: 0, truncated: false };
    }
    let chunk = "";
    if (truncated && !written.current.truncated) {
      chunk += "\x1b[2m… staršie udalosti boli vynechané …\x1b[0m\r\n";
      written.current.truncated = true;
    }
    for (const entry of entries.slice(written.current.count)) chunk += formatTerminalEntry(entry);
    written.current.count = entries.length;
    if (chunk) current.term.write(chunk);
  }, [entries, runId, truncated]);

  return <div className="orchestrator-activity-terminal" ref={host} aria-hidden="true"
    style={{ "--terminal-background": theme.background } as CSSProperties} />;
}

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  const scroller = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [entries]);
  return <ol className="orchestrator-feed" ref={scroller} tabIndex={0} aria-label="Udalosti agentov"
    onScroll={(event) => {
      const element = event.currentTarget;
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }}>
    {entries.map((entry, index) => <li key={index} className={`orchestrator-feed-item tone-${entry.tone} role-${entry.role}`}
      style={{ "--agent-color": rgb(entryColor(entry)) } as CSSProperties}>
      <span className="orchestrator-feed-avatar" aria-hidden="true">{entry.tag}</span>
      <div className="orchestrator-feed-body">
        <div className="orchestrator-feed-meta">
          <strong>{entry.agent ? agentLabel(entry.agent) : entry.role === "manager" ? "Orchestrátor" : "Lab-M4"}</strong>
          <time dateTime={entry.at ? new Date(entry.at).toISOString() : undefined}>{formatTime(entry.at)}</time>
        </div>
        <p><span aria-hidden="true" className="orchestrator-feed-icon">{entry.icon}</span> {entry.text}</p>
        {entry.details.length > 0 && <ul>{entry.details.map((line, i) => <li key={i}>{line.trim()}</li>)}</ul>}
      </div>
    </li>)}
  </ol>;
}

/**
 * Docked "Aktivita agentov" panel. In terminal mode it is a read-only terminal under the
 * session panes; in chat mode it is a readable message feed under the conversation.
 */
export function OrchestratorActivity({ run, variant, theme, fontFamily, fontSize, onOpenDialog, onHide }: {
  run: OrchestrationRun; variant: "terminal" | "chat"; theme: XtermThemeColors; fontFamily: string; fontSize: number;
  onOpenDialog: () => void; onHide: () => void;
}) {
  const { snapshot, events, running, busy, action } = run;
  const entries = useMemo(() => events.items.map(describeEvent), [events.items]);
  const agents = useMemo(() => summarizeAgents(events.items), [events.items]);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ start: number; height: number } | null>(null);
  const approval = snapshot?.approval;
  const lastEntry = entries.at(-1);
  const stage = snapshot ? STAGE_LABELS[snapshot.stage] ?? snapshot.stage : "Nič nebeží";

  const maxHeight = () => Math.max(MIN_HEIGHT, (panel.current?.parentElement?.clientHeight ?? 800) * 0.75);
  const clampHeight = (value: number) => Math.round(Math.min(Math.max(value, MIN_HEIGHT), maxHeight()));

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: event.clientY, height };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) setHeight(clampHeight(drag.current.height + drag.current.start - event.clientY));
  }
  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") { event.preventDefault(); setHeight((value) => clampHeight(value + KEYBOARD_STEP)); }
    if (event.key === "ArrowDown") { event.preventDefault(); setHeight((value) => clampHeight(value - KEYBOARD_STEP)); }
  }

  return <section ref={panel} className={`orchestrator-activity variant-${variant} ${collapsed ? "collapsed" : ""}`}
    aria-label="Aktivita agentov" style={collapsed ? undefined : { height }}>
    {!collapsed && <div className="orchestrator-activity-resize" role="separator" aria-orientation="horizontal"
      aria-label="Zmeniť výšku panelu aktivity" aria-valuenow={height} aria-valuemin={MIN_HEIGHT} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={onResizeKey} />}
    <header className="orchestrator-activity-header">
      <span className="workspace-orchestrator-icon" aria-hidden="true" />
      <h2>Aktivita agentov</h2>
      <span className={`orchestrator-stage ${running ? "running" : ""}`}>{stage}</span>
      <ul className="orchestrator-legend" aria-label="Agenti">
        {agents.map((status) => <li key={status.key} className={`state-${status.state}`}
          style={{ "--agent-color": rgb(status.role === "manager" ? MANAGER_COLOR : providerInfo(status.agent.provider).color) } as CSSProperties}
          title={`${agentLabel(status.agent)} · ${AGENT_STATE_LABELS[status.state]}${status.task ? ` · ${status.task}` : ""}`}>
          <span className="orchestration-agent-dot" aria-hidden="true" />
          <strong>{status.tag}</strong>
          <span className="orchestrator-legend-name">{providerInfo(status.agent.provider).product}</span>
          <span className="orchestrator-legend-state">{AGENT_STATE_LABELS[status.state]}</span>
        </li>)}
      </ul>
      <div className="orchestrator-activity-actions">
        {approval && <button type="button" className="orchestrator-attention" onClick={onOpenDialog}>Čaká na schválenie</button>}
        {!approval && <button type="button" onClick={onOpenDialog}>Okno orchestrátora</button>}
        {running && <button type="button" className="orchestrator-stop" disabled={busy || snapshot?.stage === "stopping"}
          onClick={() => void action("stop")}>STOP</button>}
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Rozbaliť" : "Zbaliť"} aria-label={collapsed ? "Rozbaliť aktivitu agentov" : "Zbaliť aktivitu agentov"}>
          {collapsed ? "▴" : "▾"}
        </button>
        {!running && <button type="button" onClick={onHide} aria-label="Zavrieť aktivitu agentov" title="Zavrieť">×</button>}
      </div>
    </header>
    {!collapsed && <div className="orchestrator-activity-body">
      {entries.length === 0 && <p className="orchestrator-activity-empty">
        {snapshot ? "Čakám na prvé udalosti orchestrátora…" : "Zatiaľ nebeží žiadny beh. Zadaj úlohu v okne orchestrátora."}
      </p>}
      {variant === "terminal"
        ? <ActivityTerminal entries={entries} runId={events.runId} truncated={events.truncated}
          theme={theme} fontFamily={fontFamily} fontSize={Math.max(11, fontSize - 1)} />
        : <ActivityFeed entries={entries} />}
    </div>}
    <p className="visually-hidden" aria-live="polite" aria-atomic="true">{lastEntry ? announce(lastEntry) : ""}</p>
  </section>;
}
