import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentMarkdown } from "../agent/AgentMarkdown";
import type { AppearanceSettings } from "../settings/types";
import { DEFAULT_SELECTION, ModelPicker, PLATFORMS, type ModelCatalog, type ModelSelection, type Platform } from "./ModelPicker";
import "./chat.css";

const EMPTY_MESSAGES: Message[] = [];

interface Message {
  id: number;
  question: string;
  model: string;
  answer: string;
  error?: string;
}

export function ChatView({ visible, animation }: { visible: boolean; animation: AppearanceSettings["chatAnimation"] }) {
  const [platform, setPlatform] = useState<Platform>("codex");
  const [histories, setHistories] = useState<Partial<Record<Platform, Message[]>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<Platform, string>>>({});
  const [catalogs, setCatalogs] = useState<Partial<Record<Platform, { model: string; catalog: ModelCatalog }>>>({});
  const [choices, setChoices] = useState<Partial<Record<Platform, ModelSelection>>>({});
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const messages = histories[platform] ?? EMPTY_MESSAGES;
  const draft = drafts[platform] ?? "";
  const selection = choices[platform] ?? DEFAULT_SELECTION;
  const { model, speed, thinking } = selection;
  const requestedModel = platform === "codex" ? "" : model;
  const catalogEntry = catalogs[platform];
  const optionsReady = catalogEntry?.model === requestedModel;
  const catalog = catalogEntry?.catalog;
  const setDraft = (value: string) => setDrafts((previous) => ({ ...previous, [platform]: value }));
  function setMessages(update: (messages: Message[]) => Message[]) {
    setHistories((previous) => ({ ...previous, [platform]: update(previous[platform] ?? EMPTY_MESSAGES) }));
  }
  const [active, setActive] = useState<number>();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef<number | undefined>(undefined);
  const cancelBeforeSend = useRef(false);
  const submitted = useRef(false);
  const next = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const catalogRequests = useRef(new Map<string, Promise<ModelCatalog>>());

  useEffect(() => {
    if (!visible || optionsReady || active !== undefined) return;
    let listening = true;
    setCatalogError("");
    setCatalogLoading(true);
    const key = JSON.stringify([platform, requestedModel]);
    let request = catalogRequests.current.get(key);
    if (!request) {
      request = invoke<ModelCatalog>("chat_models", { platform, model: requestedModel || null }).finally(() => {
        catalogRequests.current.delete(key);
      });
      catalogRequests.current.set(key, request);
    }
    void request.then((catalog) => {
      if (listening) {
        setCatalogs((previous) => ({ ...previous, [platform]: { model: requestedModel, catalog } }));
        setCatalogLoading(false);
      }
    }).catch((reason: unknown) => {
      if (listening) {
        setCatalogError(String(reason));
        setCatalogLoading(false);
      }
    });
    return () => { listening = false; };
  }, [visible, optionsReady, requestedModel, platform, catalogAttempt, active]);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);

  function update(id: number, change: (message: Message) => Message) {
    setMessages((previous) => previous.map((message) => message.id === id ? change(message) : message));
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || catalogLoading || activeRef.current !== undefined) return;
    if (new TextEncoder().encode(question).length > 32_768) {
      setError("Správa je príliš dlhá.");
      return;
    }
    const id = ++next.current;
    activeRef.current = id;
    cancelBeforeSend.current = false;
    submitted.current = false;
    setActive(id);
    setError("");
    setDraft("");
    setMessages((previous) => [...previous, { id, question, model: model || "Predvolený model", answer: "" }]);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<{ requestId: number; text: string }>("chat-delta", ({ payload }) => {
        if (payload.requestId === id && activeRef.current === id) {
          update(id, (message) => ({ ...message, answer: message.answer + payload.text }));
        }
      });
      if (cancelBeforeSend.current) throw Error("Odpoveď bola zastavená.");
      submitted.current = true;
      const answer = await invoke<string>("chat_send", {
        requestId: id, message: question, platform, model: model || null,
        speed: speed || null, thinking: thinking || null,
      });
      update(id, (message) => ({ ...message, answer }));
    } catch (reason) {
      update(id, (message) => ({ ...message, error: String(reason) }));
    } finally {
      unlisten?.();
      activeRef.current = undefined;
      setActive(undefined);
      setStopping(false);
    }
  }

  async function stop() {
    const id = activeRef.current;
    if (id === undefined || stopping) return;
    setStopping(true);
    if (!submitted.current) {
      cancelBeforeSend.current = true;
      return;
    }
    try {
      await invoke("chat_stop", { requestId: id });
    } catch (reason) {
      setError(String(reason));
      setStopping(false);
    }
  }

  async function reset() {
    try {
      await invoke("chat_reset", { platform });
      setMessages(() => []);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <main className="conversation-view" aria-label="Chat s modelom">
      <header className="conversation-header">
        <div>
          <h1>Chat</h1>
          <p>Prihlásenie cez {platform === "opencode" ? "OpenCode" : PLATFORMS[platform].cli}</p>
        </div>
        <button type="button" disabled={catalogLoading || active !== undefined || !messages.length} onClick={() => void reset()}>
          Nový chat
        </button>
      </header>
      <div className="conversation-scroll" ref={scroll}>
        <div className="conversation-content">
          {!messages.length && (
            <div className="conversation-empty">
              <h2>S čím ti môžem pomôcť?</h2>
              <p>Odoslaná správa sa spracuje cez tvoj účet v {PLATFORMS[platform].company}.</p>
            </div>
          )}
          {messages.map(({ id, question, model: usedModel, answer, error: turnError }) => (
            <div className="conversation-turn" key={id}>
              <div className="conversation-question" title={usedModel}>{question}</div>
              {(answer || turnError || active === id) && (
                <div className="conversation-answer">
                  {answer && <AgentMarkdown text={answer} />}
                  {active === id && (
                    <p className="conversation-status" role="status">
                      {animation !== "off" && !stopping && (
                        <span className="conversation-indicator" data-animation={animation} aria-hidden="true">
                          <i /><i /><i />
                        </span>
                      )}
                      {stopping ? "Zastavujem…" : answer ? "Model odpovedá…" : "Čakám na odpoveď…"}
                    </p>
                  )}
                  {turnError && <p role="alert">{turnError} Ďalšia správa začne nový kontext.</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <form className="conversation-composer" onSubmit={(event) => void send(event)}>
        {error && <p role="alert">{error}</p>}
        <textarea aria-label="Správa v chate" placeholder="Napíš správu…" rows={3}
          maxLength={16_384} value={draft} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
        <div className="conversation-controls">
          <ModelPicker platform={platform} selection={selection} catalog={catalog} optionsReady={optionsReady}
            loading={catalogLoading} error={catalogError} visible={visible} disabled={active !== undefined}
            onPlatform={(value) => {
              if (value === platform) return;
              setError("");
              setCatalogError("");
              setPlatform(value);
            }}
            onSelection={(value) => setChoices((previous) => ({ ...previous, [platform]: value }))}
            onRetry={() => setCatalogAttempt((value) => value + 1)} />
          {active === undefined
            ? <button type="submit" disabled={catalogLoading || !draft.trim()}>Odoslať</button>
            : <button type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? "Zastavujem…" : "STOP"}</button>}
        </div>
      </form>
    </main>
  );
}
