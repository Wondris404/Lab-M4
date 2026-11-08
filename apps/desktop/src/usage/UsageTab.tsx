import { useMemo, useState } from 'react';
import { formatFull, formatShort } from './format';
import { usageCsv } from './csv';
import { useUsage } from './useUsage';
import { addUsageTokens, selectUsage, usageState, type SortField } from './viewModel';
import './usage.css';

export interface UsageItem {
  agent: string;
  model: string;
  session: string;
  sessionKnown?: boolean;
  timestamp: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  costUsd?: number;
  costSource?: 'skutočné' | 'odhad' | 'neznáme';
  warnings: string[];
}
export function UsageTab() {
  const { records, sources, warnings, partial, loading, error, refresh, addSource, removeSource } =
    useUsage();
  const [sourceAgent, setSourceAgent] = useState('codex');
  const [folder, setFolder] = useState(true);
  const [sort, setSort] = useState<SortField>('timestamp');
  const [descending, setDescending] = useState(true);
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [day, setDay] = useState('');
  const [session, setSession] = useState('');
  const shown = useMemo(
    () =>
      selectUsage(records, { agent, model, day, session }, sort, descending),
    [records, agent, model, day, session, sort, descending],
  );
  const status = usageState(loading, error, sources.length, shown.length);
  const tokens = shown.reduce<number | undefined>(addUsageTokens, 0);
  const known = shown.filter((r) => r.costUsd !== undefined);
  const cost = known.length
    ? `${formatFull(Math.round(known.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 100) / 100)} USD`
    : '—';
  const days = useMemo(() => {
    const result = new Map<string, number | undefined>();
    shown.forEach((r) => {
      const date = r.timestamp.slice(0, 10);
      const previous = result.has(date) ? result.get(date) : 0;
      result.set(date, addUsageTokens(previous, r));
    });
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);
  const max = days.reduce((value, [, n]) => n === undefined ? value : Math.max(value, n), 1);
  const toggleSort = (field: SortField) => {
    if (sort === field) setDescending(!descending);
    else {
      setSort(field);
      setDescending(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([usageCsv(shown, partial, warnings)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'usage.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <main className="usage-tab" aria-label="Usage">
      <h1>Usage</h1>
      <p role="note">Údaje Usage sa spracúvajú iba lokálne v tomto počítači. Neodosielajú sa na server ani na GitHub.
        CSV sa uloží lokálne a obsahuje vaše skutočné údaje; zdieľajte ho iba vedome.</p>
      <div className="usage-filters">
        <label>
          Zdroj{' '}
          <select
            value={sourceAgent}
            onChange={(e) => {
              setSourceAgent(e.target.value);
              setFolder(e.target.value === 'codex');
            }}
          >
            <option value="codex">Codex</option>
            <option value="grok-build">Grok Build</option>
            <option value="opencode">OpenCode</option>
          </select>
        </label>
        {sourceAgent === 'codex' && (
          <label>
            <input
              type="checkbox"
              checked={folder}
              onChange={(e) => setFolder(e.target.checked)}
            />{' '}
            Priečinok
          </label>
        )}
        <button
          disabled={loading}
          onClick={() => void addSource(sourceAgent, folder)}
        >
          Pridať zdroj
        </button>
        <button disabled={loading} onClick={() => void refresh()}>
          Obnoviť
        </button>
        <button disabled={loading || status === 'error' || !shown.length} onClick={download}>
          Exportovať CSV
        </button>
      </div>
      {status === 'loading' && <p role="status">Načítavam údaje Usage…</p>}
      {status === 'error' && <p role="alert">{error}</p>}
      {partial && status !== 'loading' && status !== 'error' && (
        <p role="status">Orientačný odhad, nie fakturácia. Súčet môže obsahovať replay (dvojité započítanie) alebo podpočítanie chýbajúceho zdroja.</p>
      )}
      {status === 'needs-source' && (
        <p>Vyberte zdroj, ktorý chcete zahrnúť do Usage.</p>
      )}
      {sources.length > 0 && (
        <>
          <h2>Uložené zdroje</h2>
          <ul>
            {sources.map((source) => (
              <li key={source.id}>
                {source.agent} ({source.name}){' '}
                <button
                  disabled={loading}
                  aria-label={`Odobrať z Usage: ${source.agent} (${source.name})`}
                  onClick={() => void removeSource(source.id)}
                >
                  Odobrať z Usage
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="usage-filters">
        <label>
          Agent{' '}
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Všetci</option>
            {[...new Set(records.map((r) => r.agent))].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Všetky</option>
            {[...new Set(records.map((r) => r.model))].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Deň{' '}
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
        <label>
          Relácia{' '}
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">Všetky</option>
            {[...new Set(records.filter((r) => r.sessionKnown !== false).map((r) => r.session))].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      {status === 'empty' && <p>Žiadne záznamy pre vybrané filtre.</p>}
      {status === 'ready' && (
        <>
          <div className="usage-cards">
            <div>
              Tokeny{' '}
              {tokens === undefined ? <><strong>—</strong><span> Súčet tokenov nemožno presne zobraziť.</span></> :
                <strong title={formatFull(tokens)}>{formatShort(tokens)}</strong>}
            </div>
            <div>
              Známe relácie{' '}
              <strong>
                {formatFull(
                  new Set(shown.filter((r) => r.sessionKnown !== false).map((r) => `${r.agent}:${r.session}`)).size,
                )}
              </strong>
              {shown.some((r) => r.sessionKnown === false) && <span> Neúplné: neznáme relácie</span>}
            </div>
            <div>
              Cena (USD) <strong>{cost}</strong>
              {known.length > 0 && known.length < shown.length && ' (neúplné údaje)'}
              {(partial || known.length < shown.length) && (
                <span> Čiastočné / NEOVERENÉ</span>
              )}
            </div>
          </div>
          <h2>Denný prehľad</h2>
          <div className="usage-chart" role="list">
            {days.map(([d, n]) => (
              <div key={d} role="listitem">
                <span>{d}</span>
                {n === undefined ? <span>—</span> : <>
                  <meter min={0} max={max} value={n} />
                  <span>{formatFull(n)}</span>
                </>}
              </div>
            ))}
          </div>
          <h2>Záznamy</h2>
          <table>
            <thead>
              <tr>
                {(
                  [
                    ['timestamp', 'Deň'],
                    ['agent', 'Agent'],
                    ['model', 'Model'],
                    ['session', 'Relácia'],
                    ['input', 'Vstup'],
                    ['output', 'Výstup'],
                    ['cached', 'Cache'],
                    ['reasoning', 'Reasoning'],
                  ] as [SortField, string][]
                ).map(([field, label]) => (
                  <th
                    key={field}
                    aria-sort={
                      sort === field
                        ? descending
                          ? 'descending'
                          : 'ascending'
                        : 'none'
                    }
                  >
                    <button onClick={() => toggleSort(field)}>{label}</button>
                  </th>
                ))}
                <th>USD</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.agent}-${r.session}-${r.timestamp}-${i}`}>
                  <td>{r.timestamp.slice(0, 10)}</td>
                  <td>{r.agent}</td>
                  <td>{r.model}</td>
                  <td>{r.sessionKnown === false ? 'Neznáma' : r.session}</td>
                  <td>{formatFull(r.input)}</td>
                  <td>{formatFull(r.output)}</td>
                  <td>{formatFull(r.cached)}</td>
                  <td>{formatFull(r.reasoning)}</td>
                  <td>
                    {r.costUsd === undefined ? '—' : formatFull(r.costUsd)}
                    {r.costUsd !== undefined && r.costSource === 'odhad' && ' (odhad)'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Upozornenia</h2>
      {warnings.length || shown.some((r) => r.warnings.length) ? (
        <ul>
          {[...warnings, ...shown.flatMap((r) => r.warnings)].map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : (
        <p>Žiadne upozornenia.</p>
      )}
    </main>
  );
}
