import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export const PLATFORMS = {
  codex: { company: "OpenAI", cli: "Codex CLI" },
  "grok-build": { company: "xAI", cli: "Grok Build" },
  opencode: { company: "OpenCode", cli: "Viacerí poskytovatelia" },
} as const;

export type Platform = keyof typeof PLATFORMS;
export interface Choice { id: string; name: string; description?: string | null }
export interface ModelOptions { speed: Choice[]; thinking: Choice[] }
export interface Model { id: string; name: string; options: ModelOptions }
export interface ModelCatalog { models: Model[]; defaultModel?: string | null; options: ModelOptions }
export interface ModelSelection { model: string; speed: string; thinking: string }
export const DEFAULT_SELECTION: ModelSelection = { model: "", speed: "", thinking: "" };

const STEPS = ["Firma", "Model", "Rýchlosť", "Thinking"] as const;
const EMPTY_OPTIONS: ModelOptions = { speed: [], thinking: [] };
const PLATFORM_IDS: Platform[] = ["codex", "grok-build", "opencode"];

function ChoiceRow({ name, detail, selected, disabled, onClick }: {
  name: string; detail?: ReactNode; selected: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className="chat-picker-row" aria-pressed={selected} disabled={disabled} onClick={onClick}>
      <span>
        <strong>{name}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <span aria-hidden="true">{selected ? "✓" : "›"}</span>
    </button>
  );
}

export function ModelPicker({ platform, selection, catalog, optionsReady, loading, error, visible, disabled,
  onPlatform, onSelection, onRetry }: {
  platform: Platform; selection: ModelSelection; catalog?: ModelCatalog; optionsReady: boolean;
  loading: boolean; error: string; visible: boolean; disabled: boolean;
  onPlatform: (platform: Platform) => void; onSelection: (selection: ModelSelection) => void; onRetry: () => void;
}) {
  const [step, setStep] = useState<number>();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = step !== undefined;
  const activeModel = catalog?.models.find((model) => model.id === (selection.model || catalog.defaultModel));
  const options = platform === "codex" ? activeModel?.options ?? EMPTY_OPTIONS
    : optionsReady ? catalog?.options ?? EMPTY_OPTIONS : EMPTY_OPTIONS;
  const summary = activeModel?.name ?? (selection.model || "Predvolený model");
  const models = [...new Map(catalog?.models.map((model) => [model.id, model])).values()];
  const term = query.trim().toLowerCase();

  function close() {
    setStep(undefined);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!visible || disabled) setStep(undefined);
  }, [visible, disabled]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setStep(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useEffect(() => {
    if (step !== undefined) panel.current?.focus();
  }, [step]);

  function chooseModel(model: string) {
    if (selection.model !== model) onSelection({ ...DEFAULT_SELECTION, model });
    setStep(2);
  }

  const field = step === 2 ? "speed" : "thinking";

  return (
    <div className="chat-picker" ref={root}>
      <button type="button" className="chat-picker-trigger" ref={trigger} disabled={disabled}
        aria-label={`Vybrať model. ${PLATFORMS[platform].company}, ${summary}`}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { setQuery(""); setStep(open ? undefined : 0); }}>
        <span className="chat-picker-mark" aria-hidden="true">◈</span>
        <span className="chat-picker-trigger-name">{summary}</span>
        <span aria-hidden="true">⌃</span>
      </button>
      {step !== undefined && (
        <div className="chat-picker-panel" ref={panel} role="dialog" tabIndex={-1} id={id} aria-labelledby={id + "-title"}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}>
          <div className="chat-picker-heading">
            {step > 0 && (
              <button type="button" className="chat-picker-back" aria-label="Späť" onClick={() => setStep(step - 1)}>‹</button>
            )}
            <span id={id + "-title"}>{STEPS[step]}</span>
            <span className="chat-picker-progress">{step + 1} / {STEPS.length}</span>
          </div>
          {step === 1 && models.length > 8 && (
            <div className="chat-picker-search">
              <input type="search" aria-label="Hľadať model" placeholder="Hľadať model…" value={query}
                onChange={(event) => setQuery(event.target.value)} />
            </div>
          )}
          <div className="chat-picker-rows" onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".chat-picker-row:not(:disabled)")];
            if (!buttons.length) return;
            event.preventDefault();
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = current < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
              : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}>
            {step === 0 && PLATFORM_IDS.map((item) => (
              <ChoiceRow key={item} name={PLATFORMS[item].company} detail={PLATFORMS[item].cli}
                selected={platform === item} disabled={loading && platform !== item}
                onClick={() => { onPlatform(item); setQuery(""); setStep(1); }} />
            ))}
            {step === 1 && (
              <>
                {loading && <p role="status">Načítavam modely…</p>}
                {error && <p role="alert">{error} <button type="button" onClick={onRetry}>Skúsiť znova</button></p>}
                {!term && (
                  <ChoiceRow name="Predvolený model CLI" selected={!selection.model} disabled={loading}
                    onClick={() => chooseModel("")} />
                )}
                {models.filter((item) => (item.name + " " + item.id).toLowerCase().includes(term)).map((item) => (
                  <ChoiceRow key={item.id} name={item.name} detail={item.name !== item.id ? item.id : undefined}
                    selected={selection.model === item.id} disabled={loading} onClick={() => chooseModel(item.id)} />
                ))}
                {!!term && !models.some((item) => (item.name + " " + item.id).toLowerCase().includes(term)) &&
                  <p>Žiadny zodpovedajúci model.</p>}
              </>
            )}
            {step >= 2 && (
              <>
                {loading && <p role="status">Načítavam možnosti modelu…</p>}
                {!loading && error && <p role="alert">{error} <button type="button" onClick={onRetry}>Skúsiť znova</button></p>}
                <ChoiceRow name="Predvolené nastavenie CLI" selected={!selection[field]} disabled={loading}
                  detail={!loading && !options[field].length ? "Pre tento model CLI ďalšie možnosti neponúka." : undefined}
                  onClick={() => {
                    onSelection({ ...selection, [field]: "" });
                    if (step === 2) setStep(3); else close();
                  }} />
                {options[field].map((choice) => (
                  <ChoiceRow key={choice.id} name={choice.name} detail={choice.description}
                    selected={selection[field] === choice.id} disabled={loading} onClick={() => {
                      onSelection({ ...selection, [field]: choice.id });
                      if (step === 2) setStep(3); else close();
                    }} />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
