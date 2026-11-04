import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-14">
      <header className="border-b border-zinc-800 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Lab-M4</h1>
      </header>
      <section className="py-24 text-center" aria-label="Stav údajov">
        <p className="text-lg text-zinc-400">Zatiaľ žiadne dáta</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
