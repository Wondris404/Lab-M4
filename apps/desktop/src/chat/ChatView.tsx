import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentMarkdown } from "../agent/AgentMarkdown";
import "./chat.css";

interface Message {
  id: number;
  question: string;
  answer: string;
  error?: string;
}

export function ChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<number>();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const activeRef = useRef<number | undefined>(undefined);
  const cancelBeforeSend = useRef(false);
  const submitted = useRef(false);
  const next = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);

  function update(id: number, change: (message: Message) => Message) {
    setMessages((previous) => previous.map((message) => message.id === id ? change(message) : message));
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || activeRef.current !== undefined) return;
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
    setMessages((previous) => [...previous, { id, question, answer: "" }]);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<{ requestId: number; text: string }>("chat-delta", ({ payload }) => {
        if (payload.requestId === id && activeRef.current === id) {
          update(id, (message) => ({ ...message, answer: message.answer + payload.text }));
        }
      });
      if (cancelBeforeSend.current) throw Error("Odpoveď bola zastavená.");
      submitted.current = true;
      const answer = await invoke<string>("chat_send", { requestId: id, message: question });
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
      await invoke("chat_reset");
      setMessages([]);
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
          <p>Codex · prihlásenie cez Codex CLI</p>
        </div>
        <button type="button" disabled={active !== undefined || !messages.length} onClick={() => void reset()}>
          Nový chat
        </button>
      </header>
      <div className="conversation-scroll" ref={scroll}>
        <div className="conversation-content">
          {!messages.length && (
            <div className="conversation-empty">
              <h2>S čím ti môžem pomôcť?</h2>
              <p>Odoslaná správa sa spracuje cez tvoj účet v Codex CLI.</p>
            </div>
          )}
          {messages.map(({ id, question, answer, error: turnError }) => (
            <div className="conversation-turn" key={id}>
              <div className="conversation-question">{question}</div>
              {(answer || turnError || active === id) && (
                <div className="conversation-answer">
                  {answer && <AgentMarkdown text={answer} />}
                  {active === id && !answer && <p role="status">Čakám na odpoveď…</p>}
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
        {active === undefined
          ? <button type="submit" disabled={!draft.trim()}>Odoslať</button>
          : <button type="button" disabled={stopping} onClick={() => void stop()}>{stopping ? "Zastavujem…" : "STOP"}</button>}
      </form>
    </main>
  );
}
