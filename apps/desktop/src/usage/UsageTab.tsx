import { useMemo, useState } from 'react';
import {
  buildUsageDashboard,
  metricValue,
  PERIODS,
  periodStart,
  providerInfo,
  usageDay,
  type UsageMetric,
  type UsagePeriod,
} from './dashboard';
import { formatFull } from './format';
import { usageCsv } from './csv';
import { useUsage } from './useUsage';
import { selectUsage, usageState, type SortField } from './viewModel';
import { formatMetric, UsageChart } from './UsageChart';
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

const columns: [SortField, string][] = [
  ['timestamp', 'Deň'],
  ['agent', 'Agent'],
  ['model', 'Model'],
  ['session', 'Relácia'],
  ['input', 'Vstup'],
  ['output', 'Výstup'],
  ['cached', 'Cache'],
  ['reasoning', 'Reasoning'],
];
const PAGE_SIZE = 50;
const percent = new Intl.NumberFormat('sk-SK', {
  style: 'percent',
  maximumFractionDigits: 1,
});

export function UsageTab({
  visible = true,
  theme = 'light',
}: {
  visible?: boolean;
  theme?: 'light' | 'dark';
}) {
  const {
    records,
    sources,
    warnings,
    loading,
    error,
    refresh,
    addSource,
    partial,
    stale,
    changeSource,
  } = useUsage(visible);
  const [period, setPeriod] = useState<UsagePeriod>('all');
  const [metric, setMetric] = useState<UsageMetric>('tokens');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [day, setDay] = useState('');
  const [session, setSession] = useState('');
  const [sourceAgent, setSourceAgent] = useState('codex');
  const [folder, setFolder] = useState(true);
  const [sort, setSort] = useState<SortField>('timestamp');
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(0);

  const now = useMemo(() => Date.now(), [records, visible, period]);
  const start = periodStart(period, now);
  const inPeriod = useMemo(
    () =>
      records.filter((record) => {
        const timestamp = Date.parse(record.timestamp);
        return timestamp >= start && timestamp <= now;
      }),
    [records, start, now],
  );
  const shown = useMemo(
    () =>
      selectUsage(inPeriod, { agent, model, day, session }, sort, descending),
    [inPeriod, agent, model, day, session, sort, descending],
  );
  const dashboard = useMemo(
    () => buildUsageDashboard(shown, period, now),
    [shown, period, now],
  );
  const total = dashboard.total;
  const activeValue = metricValue(total, metric);
  const providers = [...dashboard.agents].sort(
    (a, b) =>
      (metricValue(b[1], metric) ?? 0) - (metricValue(a[1], metric) ?? 0),
  );
  const modelRows = [...dashboard.models].sort(
    (a, b) => (metricValue(b, metric) ?? 0) - (metricValue(a, metric) ?? 0),
  );
  const notices = [
    ...new Set([
      ...warnings,
      ...shown.flatMap((row) => row.warnings),
      ...(shown.some((row) => row.sessionKnown === false) ? ['Neúplné: neznáme relácie'] : []),
    ]),
  ];
  const status = usageState(
    loading,
    error,
    sources.filter((source) => source.enabled !== false).length,
    shown.length,
  );
  const composition = [
    {
      label: 'Vstup bez cache',
      count: total.input - total.cached,
      color: 'var(--usage-uncached)',
    },
    {
      label: 'Vstup z cache',
      count: total.cached,
      color: 'var(--usage-cached)',
    },
    { label: 'Výstup', count: total.output, color: 'var(--usage-output)' },
  ];
  const allTokens = metricValue(total, 'tokens');
  const pageCount = Math.ceil(shown.length / PAGE_SIZE);
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const updateAgent = (value: string) => {
    setAgent(value);
    setModel('');
    setSession('');
    setPage(0);
  };
  const toggleSort = (field: SortField) => {
    setPage(0);
    if (sort === field) setDescending(!descending);
    else {
      setSort(field);
      setDescending(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([usageCsv(shown, partial, notices)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'usage.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="usage-tab" data-usage-theme={theme} aria-label="Usage">
      <div className="usage-toolbar">
        <div className="usage-toolbar-inner">
          <h1>Usage</h1>
          <select
            aria-label="Agent"
            value={agent}
            onChange={(event) => updateAgent(event.target.value)}
          >
            <option value="">Všetci agenti</option>
            {[...new Set(records.map((record) => record.agent))].map(
              (value) => (
                <option key={value} value={value}>
                  {providerInfo(value).label}
                </option>
              ),
            )}
          </select>
          <div
            className="usage-segment usage-period"
            role="group"
            aria-label="Obdobie"
          >
            {PERIODS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => {
                  setPeriod(value);
                  setDay('');
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="usage-segment" role="group" aria-label="Metrika">
            <button
              type="button"
              aria-pressed={metric === 'tokens'}
              onClick={() => setMetric('tokens')}
            >
              Tokeny
            </button>
            <button
              type="button"
              aria-pressed={metric === 'cost'}
              onClick={() => setMetric('cost')}
            >
              Cena
            </button>
          </div>
          <div className="usage-actions">
            <button
              type="button"
              className="usage-button"
              disabled={loading}
              onClick={() => void refresh()}
            >
              Obnoviť
            </button>
          </div>
        </div>
      </div>

      <div className="usage-content">
        <div className="usage-notices">
          <p>História Usage sa spracúva lokálne. Export CSV obsahuje vaše skutočné údaje.</p>
          {partial && <p role="status">Orientačný odhad. Niektoré údaje môžu chýbať alebo byť započítané opakovane.</p>}
          {allTokens === null && <p role="alert">Súčet tokenov nemožno presne zobraziť. Vyber kratšie obdobie alebo konkrétneho agenta.</p>}
          {status === 'loading' && (
            <p role="status">
              {records.length
                ? 'Obnovujem históriu na pozadí…'
                : 'Načítavam údaje Usage…'}
            </p>
          )}
          {error && (
            <p role="alert" className="usage-error">
              {error}
            </p>
          )}
          {notices.length > 0 && (
            <details>
              <summary>
                Údaje môžu byť neúplné <span>{notices.length}</span>
              </summary>
              <ul>
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {(model || day || session) && (
          <div className="usage-active-filters">
            <span>
              {[model, day, session ? 'Vybraná relácia' : '']
                .filter(Boolean)
                .join(' · ')}
            </span>
            <button
              type="button"
              className="usage-button"
              onClick={() => {
                setModel('');
                setDay('');
                setSession('');
                setPage(0);
              }}
            >
              Vymazať filtre
            </button>
          </div>
        )}
        {shown.length > 0 ? (
          <>
            <div className="usage-overview">
              <section
                className="usage-summary"
                aria-label="Súhrn podľa agenta"
              >
                <p className="usage-kicker">
                  {metric === 'tokens'
                    ? 'Spracované tokeny'
                    : 'Dostupný odhad ceny'}
                </p>
                <strong
                  className="usage-hero"
                  title={formatMetric(activeValue, metric)}
                >
                  {formatMetric(activeValue, metric, true)}
                </strong>
                <p className="usage-muted">
                  Známe relácie <strong>{formatFull(total.sessions.size)}</strong>
                </p>
                <ul className="usage-providers">
                  {providers.map(([name, group]) => {
                    const info = providerInfo(name);
                    const value = metricValue(group, metric);
                    return (
                      <li key={name}>
                        <button
                          type="button"
                          aria-pressed={agent === name}
                          onClick={() =>
                            updateAgent(agent === name ? '' : name)
                          }
                        >
                          <i
                            className="usage-dot"
                            style={{ background: info.color }}
                          />
                          <span>{info.label}</span>
                          <strong title={formatMetric(value, metric)}>
                            {formatMetric(value, metric, true)}
                          </strong>
                        </button>
                        <small>
                          {formatFull(group.sessions.size)} relácií
                          {value !== null &&
                            activeValue !== null &&
                            activeValue > 0 &&
                            ` · ${percent.format(value / activeValue)}`}
                        </small>
                      </li>
                    );
                  })}
                </ul>
              </section>
              <UsageChart
                key={`${period}-${metric}`}
                dashboard={dashboard}
                metric={metric}
              />
            </div>

            <section className="usage-totals" aria-label="Rozdelenie spotreby">
              <h2>Súčty</h2>
              <dl>
                <div>
                  <dt>Spracované tokeny</dt>
                  <dd title={formatMetric(allTokens, 'tokens')}>
                    {formatMetric(allTokens, 'tokens', true)}
                  </dd>
                </div>
                {composition.map(({ label, count }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd title={formatMetric(allTokens === null ? null : count, 'tokens')}>
                      {formatMetric(allTokens === null ? null : count, 'tokens', true)}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Odhad ceny</dt>
                  <dd>{formatMetric(metricValue(total, 'cost'), 'cost')}</dd>
                  {total.priced < total.count && (
                    <small>
                      {total.priced
                        ? 'Čiastočné / NEOVERENÉ'
                        : 'Cena nie je dostupná'}
                    </small>
                  )}
                </div>
              </dl>
              {allTokens !== null && allTokens > 0 && (
                <div className="usage-composition">
                  <h3>Tokeny podľa typu</h3>
                  <div
                    className="usage-composition-track"
                    role="img"
                    aria-label={composition
                      .map(
                        ({ label, count }) => `${label} ${formatFull(count)}`,
                      )
                      .join(', ')}
                  >
                    {composition.map(
                      ({ label, count, color }) =>
                        count > 0 && (
                          <span
                            key={label}
                            style={{
                              flexGrow: count / allTokens,
                              background: color,
                            }}
                          />
                        ),
                    )}
                  </div>
                  <ul>
                    {composition.map(({ label, count, color }) => (
                      <li key={label}>
                        <i
                          className="usage-dot"
                          style={{ background: color }}
                        />
                        {label}{' '}
                        <strong>{formatMetric(count, 'tokens', true)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="usage-breakdown">
              <h2>
                Rozdelenie podľa modelu
                {modelRows.length > 8 && <small>Prvých 8</small>}
              </h2>
              <div className="usage-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Agent</th>
                      <th className="usage-number">Podiel</th>
                      <th className="usage-number">
                        {metric === 'tokens' ? 'Tokeny' : 'Odhad (USD)'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelRows.slice(0, 8).map((row) => {
                      const value = metricValue(row, metric);
                      const share =
                        value !== null &&
                        activeValue !== null &&
                        activeValue > 0
                          ? value / activeValue
                          : null;
                      const info = providerInfo(row.agent);
                      return (
                        <tr key={JSON.stringify([row.agent, row.model])}>
                          <td>{row.model}</td>
                          <td>
                            <span className="usage-agent-label">
                              <i
                                className="usage-dot"
                                style={{ background: info.color }}
                              />
                              {info.label}
                            </span>
                          </td>
                          <td className="usage-number">
                            {share === null ? '—' : percent.format(share)}
                          </td>
                          <td
                            className="usage-number"
                            title={formatMetric(value, metric)}
                          >
                            {formatMetric(value, metric, true)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <div className="usage-empty">
            <h2>
              {status === 'needs-source'
                ? 'Zatiaľ bez zdrojov'
                : status === 'loading'
                  ? 'Pripravujem prehľad'
                  : 'Žiadne záznamy'}
            </h2>
            <p>
              {status === 'needs-source'
                ? 'História CLI sa hľadá automaticky. Ďalší zdroj môžeš pridať nižšie.'
                : status === 'loading'
                  ? 'História sa zobrazí po načítaní.'
                  : 'Pre toto obdobie alebo výber nie je dostupná história.'}
            </p>
          </div>
        )}

        <details className="usage-panel">
          <summary>
            Záznamy a filtre <span>{formatFull(shown.length)}</span>
          </summary>
          <div className="usage-panel-content">
            <div className="usage-filters">
              <label>
                Model
                <select
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">Všetky</option>
                  {[
                    ...new Set(
                      records
                        .filter((row) => !agent || row.agent === agent)
                        .map((row) => row.model),
                    ),
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Deň
                <input
                  type="date"
                  value={day}
                  onChange={(event) => {
                    setDay(event.target.value);
                    setPage(0);
                  }}
                />
              </label>
              <label>
                Relácia
                <select
                  className="usage-session-filter"
                  value={session}
                  onChange={(event) => {
                    setSession(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">Všetky</option>
                  {[
                    ...new Set(
                      records
                        .filter((row) => row.sessionKnown !== false && (!agent || row.agent === agent))
                        .map((row) => row.session),
                    ),
                  ].map((value) => (
                    <option key={value} value={value}>
                      {value.length > 18 ? `${value.slice(0, 14)}…` : value}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="usage-button"
                disabled={loading || stale || !!error || !shown.length}
                onClick={download}
              >
                Exportovať CSV
              </button>
            </div>
            {shown.length > 0 && (
              <>
                <div className="usage-table-wrap usage-ledger">
                  <table>
                    <thead>
                      <tr>
                        {columns.map(([field, label]) => (
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
                            <button
                              type="button"
                              onClick={() => toggleSort(field)}
                            >
                              {label}
                              {sort === field && (descending ? ' ↓' : ' ↑')}
                            </button>
                          </th>
                        ))}
                        <th>USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown
                        .slice(
                          currentPage * PAGE_SIZE,
                          (currentPage + 1) * PAGE_SIZE,
                        )
                        .map((row, index) => (
                          <tr
                            key={`${row.agent}-${row.session}-${row.timestamp}-${index}`}
                          >
                            <td>{usageDay(row.timestamp)}</td>
                            <td>{providerInfo(row.agent).label}</td>
                            <td>{row.model}</td>
                            <td
                              className="usage-session-cell"
                              title={row.sessionKnown === false ? undefined : row.session}
                            >
                              {row.sessionKnown === false ? 'Neznáma' : row.session}
                            </td>
                            <td>{formatFull(row.input)}</td>
                            <td>{formatFull(row.output)}</td>
                            <td>{formatFull(row.cached)}</td>
                            <td>{formatFull(row.reasoning)}</td>
                            <td>
                              {row.costUsd === undefined
                                ? '—'
                                : formatFull(row.costUsd)}
                              {row.costUsd !== undefined && row.costSource === 'odhad' && ' (odhad)'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {pageCount > 1 && (
                  <div className="usage-pager">
                    <button
                      type="button"
                      className="usage-button"
                      disabled={currentPage === 0}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      Predošlá
                    </button>
                    <span>
                      Strana {currentPage + 1} z {pageCount}
                    </span>
                    <button
                      type="button"
                      className="usage-button"
                      disabled={currentPage + 1 === pageCount}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Ďalšia
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </details>

        <details className="usage-panel">
          <summary>
            Zdroje histórie <span>{sources.length}</span>
          </summary>
          <div className="usage-panel-content">
            <ul className="usage-sources">
              {sources.map((source) => (
                <li key={source.id}>
                  <span>
                    <strong>{providerInfo(source.agent).label}</strong>{' '}
                    <small>
                      · {source.name}{source.automatic && ' · Automatický'}
                      {source.enabled === false && ' · Vypnutý'}
                      {source.coveredBy && ' · Prekrýva sa s iným zdrojom'}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="usage-button"
                    disabled={loading}
                    aria-label={source.automatic ? undefined : `Odobrať z Usage: ${source.agent} (${source.name})`}
                    onClick={() => void changeSource(source)}
                  >
                    {source.automatic ? (source.enabled === false ? 'Zapnúť' : 'Vypnúť') : 'Odobrať'}
                  </button>
                </li>
              ))}
            </ul>
            <div className="usage-filters">
              <label>
                Typ zdroja
                <select
                  value={sourceAgent}
                  onChange={(event) => {
                    setSourceAgent(event.target.value);
                    setFolder(event.target.value === 'codex');
                  }}
                >
                  <option value="codex">Codex</option>
                  <option value="grok-build">Grok Build</option>
                  <option value="opencode">OpenCode</option>
                </select>
              </label>
              {sourceAgent === 'codex' && (
                <label className="usage-check">
                  <input
                    type="checkbox"
                    checked={folder}
                    onChange={(event) => setFolder(event.target.checked)}
                  />{' '}
                  Priečinok
                </label>
              )}
              <button
                type="button"
                className="usage-button"
                disabled={loading}
                onClick={() => void addSource(sourceAgent, folder)}
              >
                Pridať zdroj
              </button>
            </div>
          </div>
        </details>
      </div>
    </main>
  );
}
