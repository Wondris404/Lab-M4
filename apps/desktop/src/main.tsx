import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ChatView } from "./chat/ChatView";
import { UsageTab } from "./usage/UsageTab";

function Root() {
  const [view, setView] = useState<'terminal' | 'chat' | 'usage'>('terminal');
  const [openedChat, setOpenedChat] = useState(false);
  const [openedUsage, setOpenedUsage] = useState(false);
  return <>
    <nav className="lab-tabs" aria-label="Hlavné karty">
      <button aria-selected={view === 'terminal'} onClick={() => { setView('terminal'); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); }}>Terminal</button>
      <button aria-selected={view === 'chat'} onClick={() => { setOpenedChat(true); setView('chat'); }}>Chat</button>
      <button aria-selected={view === 'usage'} onClick={() => { setOpenedUsage(true); setView('usage'); }}>Usage</button>
    </nav>
    <div className="lab-terminal" style={{ display: view === 'terminal' ? undefined : 'none' }}><App /></div>
    {openedChat && <div hidden={view !== 'chat'}><ChatView /></div>}
    {openedUsage && <div hidden={view !== 'usage'}><UsageTab /></div>}
  </>;
}
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><Root /></React.StrictMode>);
