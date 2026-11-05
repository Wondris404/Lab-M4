import { useMemo, useState } from 'react';
import { formatFull, formatShort } from './format';
import './usage.css';

export interface UsageItem {
  agent: string; model: string; session: string; timestamp: string;
  input: number; output: number; cached: number; reasoning: number;
  costEur?: number; warnings: string[];
}
interface Props { records: UsageItem[]; connected: boolean; error?: string }
export function UsageTab({ records, connected, error }: Props) {
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [day, setDay] = useState('');
  const [session, setSession] = useState('');
  const shown = useMemo(() => records.filter(r => (!agent || r.agent === agent) && (!model || r.model === model) && (!day || r.timestamp.startsWith(day)) && (!session || r.session === session)), [records, agent, model, day, session]);
  const tokens = shown.reduce((sum, r) => sum + r.input + r.output, 0);
  const known = shown.filter(r => r.costEur !== undefined);
  const cost = known.length ? `${formatFull(Math.round(known.reduce((sum, r) => sum + (r.costEur ?? 0), 0) * 100) / 100)} €` : '—';
  const days = useMemo(() => {
    const result = new Map<string, number>();
    shown.forEach(r => { const date = r.timestamp.slice(0, 10); result.set(date, (result.get(date) ?? 0) + r.input + r.output); });
    return [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);
  const max = Math.max(1, ...days.map(([, n]) => n));
  return <main className="usage-tab" aria-label="Usage">
    <h1>Usage</h1>
    {!connected && <p role="status">Usage backend zatiaľ nie je pripojený. NEOVERENÉ.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="usage-filters">
      <label>Agent <select value={agent} onChange={e => setAgent(e.target.value)}><option value="">Všetci</option>{[...new Set(records.map(r => r.agent))].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Model <select value={model} onChange={e => setModel(e.target.value)}><option value="">Všetky</option>{[...new Set(records.map(r => r.model))].map(v => <option key={v}>{v}</option>)}</select></label>
      <label>Deň <input type="date" value={day} onChange={e => setDay(e.target.value)} /></label>
      <label>Relácia <select value={session} onChange={e => setSession(e.target.value)}><option value="">Všetky</option>{[...new Set(records.map(r => r.session))].map(v => <option key={v}>{v}</option>)}</select></label>
    </div>
    {!shown.length ? <p>{connected ? 'Žiadne záznamy pre vybrané filtre.' : 'Žiadne údaje nie sú k dispozícii.'}</p> : <>
      <div className="usage-cards"><div>Tokeny <strong title={formatFull(tokens)}>{formatShort(tokens)}</strong></div><div>Relácie <strong>{formatFull(new Set(shown.map(r => `${r.agent}:${r.session}`)).size)}</strong></div><div>Cena <strong>{cost}</strong>{known.length < shown.length && <span> Čiastočné / NEOVERENÉ</span>}</div></div>
      <h2>Denný prehľad</h2><div className="usage-chart" role="list">{days.map(([d, n]) => <div key={d} role="listitem"><span>{d}</span><meter min={0} max={max} value={n} /><span>{formatFull(n)}</span></div>)}</div>
      <h2>Záznamy</h2><table><thead><tr><th>Deň</th><th>Agent</th><th>Model</th><th>Relácia</th><th>Vstup</th><th>Výstup</th><th>Cache</th><th>Reasoning</th><th>EUR</th></tr></thead><tbody>{shown.map((r, i) => <tr key={`${r.agent}-${r.session}-${r.timestamp}-${i}`}><td>{r.timestamp.slice(0, 10)}</td><td>{r.agent}</td><td>{r.model}</td><td>{r.session}</td><td>{formatFull(r.input)}</td><td>{formatFull(r.output)}</td><td>{formatFull(r.cached)}</td><td>{formatFull(r.reasoning)}</td><td>{r.costEur === undefined ? '—' : formatFull(r.costEur)}</td></tr>)}</tbody></table>
      <h2>Upozornenia</h2><ul>{shown.flatMap(r => r.warnings).map((w, i) => <li key={i}>{w}</li>)}</ul>
    </>}
  </main>;
}
