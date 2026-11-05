import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UsageTab } from "./usage/UsageTab";

function Root() {
  const [view, setView] = useState<'terminal' | 'usage'>('terminal');
  return <>
    <nav className="lab-tabs" aria-label="Hlavné karty">
      <button aria-selected={view === 'terminal'} onClick={() => { setView('terminal'); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); }}>Terminal</button>
      <button aria-selected={view === 'usage'} onClick={() => setView('usage')}>Usage</button>
    </nav>
    <div className="lab-terminal" style={{ display: view === 'terminal' ? undefined : 'none' }}><App /></div>
    {view === 'usage' && <UsageTab records={[]} connected={false} />}
  </>;
}
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode><Root /></React.StrictMode>);
