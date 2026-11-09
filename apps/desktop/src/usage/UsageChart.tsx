import { useEffect, useRef, useState } from 'react';
import {
  buildUsageDashboard,
  metricValue,
  providerInfo,
  type UsageMetric,
} from './dashboard';
import { formatFull, formatShort } from './format';

type Dashboard = ReturnType<typeof buildUsageDashboard>;
const money = new Intl.NumberFormat('sk-SK', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'code',
});
const dateLabel = new Intl.DateTimeFormat('sk-SK', {
  day: 'numeric',
  month: 'short',
});
const hourLabel = new Intl.DateTimeFormat('sk-SK', {
  hour: '2-digit',
  minute: '2-digit',
});
const exactDate = new Intl.DateTimeFormat('sk-SK', { dateStyle: 'medium' });
const exactHour = new Intl.DateTimeFormat('sk-SK', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatMetric(
  value: number | null,
  metric: UsageMetric,
  compact = false,
) {
  if (value === null) return '—';
  if (metric === 'cost') return money.format(value);
  return compact ? formatShort(value) : formatFull(value);
}

function gridStep(maximum: number) {
  if (maximum <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4));
  return (
    ([1, 2, 2.5, 5, 10].find((value) => value * magnitude >= maximum / 4) ??
      10) * magnitude
  );
}

export function UsageChart({
  dashboard,
  metric,
}: {
  dashboard: Dashboard;
  metric: UsageMetric;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { buckets, agents, hourly, step } = dashboard;
  const series = [...agents]
    .filter(([, totals]) => metric === 'tokens' || totals.priced > 0)
    .map(([agent]) => ({
      ...providerInfo(agent),
      agent,
      values: buckets.map(({ byAgent }) => {
        const totals = byAgent.get(agent);
        return totals ? metricValue(totals, metric) : 0;
      }),
    }));
  const peak = series.reduce(
    (max, { values }) =>
      values.reduce<number>(
        (current, value) => Math.max(current, value ?? 0),
        max,
      ),
    0,
  );
  const delta = gridStep(peak);
  const top = peak > 0 ? Math.ceil(peak / delta) * delta : delta;
  const marks = Array.from(
    { length: Math.round(top / delta) + 1 },
    (_, index) => index * delta,
  );
  const height = width > 560 ? 300 : 244;
  const left = metric === 'cost' ? 80 : 57;
  const right = Math.max(left + 1, width - 12);
  const base = height - 32;
  const lastIndex = Math.max(0, buckets.length - 1);
  const x = (index: number) =>
    lastIndex === 0
      ? (left + right) / 2
      : left + (index * (right - left)) / lastIndex;
  const y = (value: number) => base - (value / top) * (base - 10);
  const cursor = selected === null ? null : Math.min(selected, lastIndex);
  const activeBucket = cursor === null ? undefined : buckets[cursor];
  const tickCount = width > 580 ? 5 : 3;
  const ticks = Array.from(
    new Set(
      Array.from({ length: tickCount }, (_, index) =>
        Math.round((index * lastIndex) / (tickCount - 1)),
      ),
    ),
  );
  const description =
    metric === 'tokens'
      ? 'Spracované tokeny podľa agenta'
      : 'Dostupné odhady ceny podľa agenta';

  return (
    <section className="usage-plot" aria-label={description}>
      <div className="usage-plot-heading">
        <h2>{description}</h2>
        <span>
          {hourly ? 'Po hodinách' : step > 1 ? `Po ${step} dňoch` : 'Po dňoch'}
        </span>
      </div>
      <div
        ref={host}
        className="usage-plot-body"
        role="group"
        tabIndex={series.length ? 0 : undefined}
        aria-label={`${description}. Šípkami vyberiete dátum.`}
        onPointerMove={(event) => {
          if (!series.length || width <= left) return;
          const position =
            event.clientX - event.currentTarget.getBoundingClientRect().left;
          setSelected(
            Math.max(
              0,
              Math.min(
                lastIndex,
                Math.round(((position - left) * lastIndex) / (right - left)),
              ),
            ),
          );
        }}
        onPointerLeave={() => setSelected(null)}
        onFocus={() => setSelected(lastIndex)}
        onBlur={() => setSelected(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const direction = event.key === 'ArrowLeft' ? -1 : 1;
          setSelected((value) =>
            Math.max(0, Math.min(lastIndex, (value ?? lastIndex) + direction)),
          );
        }}
      >
        {width > left && series.length > 0 ? (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={description}
          >
            {marks.map((value) => (
              <g key={value}>
                <line
                  className="usage-gridline"
                  x1={left}
                  x2={right}
                  y1={y(value)}
                  y2={y(value)}
                />
                <text
                  className="usage-axis-label"
                  x={left - 9}
                  y={y(value) + 4}
                  textAnchor="end"
                >
                  {formatMetric(value, metric, true)}
                </text>
              </g>
            ))}
            {ticks.map((index) => {
              const bucket = buckets[index];
              if (!bucket) return null;
              return (
                <text
                  key={index}
                  className="usage-axis-label"
                  x={x(index)}
                  y={height - 10}
                  textAnchor={
                    lastIndex === 0
                      ? 'middle'
                      : index === 0
                        ? 'start'
                        : index === lastIndex
                          ? 'end'
                          : 'middle'
                  }
                >
                  {(hourly ? hourLabel : dateLabel).format(bucket.time)}
                </text>
              );
            })}
            {series.map(({ agent, color, values }) => {
              const runs: { x: number; y: number }[][] = [];
              let points: { x: number; y: number }[] = [];
              values.forEach((value, index) => {
                if (value !== null) points.push({ x: x(index), y: y(value) });
                else if (points.length) {
                  runs.push(points);
                  points = [];
                }
              });
              if (points.length) runs.push(points);
              return (
                <g key={agent}>
                  {runs.map((run, index) => {
                    const line = run
                      .map((point) => `${point.x},${point.y}`)
                      .join(' L ');
                    return (
                      <g key={index}>
                        <path
                          d={`M ${run[0]!.x},${base} L ${line} L ${run.at(-1)!.x},${base} Z`}
                          fill={color}
                          opacity={0.09}
                        />
                        <path
                          d={`M ${line}`}
                          stroke={color}
                          strokeWidth={2.1}
                          fill="none"
                          strokeLinejoin="round"
                        />
                        {run.length === 1 && (
                          <circle
                            cx={run[0]!.x}
                            cy={run[0]!.y}
                            r={3}
                            fill={color}
                          />
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {cursor !== null && (
              <>
                <line
                  className="usage-chart-guide"
                  x1={x(cursor)}
                  x2={x(cursor)}
                  y1={10}
                  y2={base}
                />
                {series.map(({ agent, values, color }) =>
                  values[cursor] == null ? null : (
                    <circle
                      key={agent}
                      cx={x(cursor)}
                      cy={y(values[cursor]!)}
                      r={4}
                      fill={color}
                      className="usage-chart-point"
                    />
                  ),
                )}
              </>
            )}
          </svg>
        ) : (
          <p className="usage-chart-empty">
            {metric === 'cost'
              ? 'Pre toto obdobie nie sú dostupné odhady ceny.'
              : 'Žiadna spotreba v tomto období.'}
          </p>
        )}
        {activeBucket && cursor !== null && series.length > 0 && (
          <div
            className="usage-tooltip"
            role="status"
            style={{ left: Math.max(0, Math.min(x(cursor) + 12, width - 202)) }}
          >
            <strong>
              {(hourly ? exactHour : exactDate).format(activeBucket.time)}
            </strong>
            {series.map(({ agent, label, color, values }) => (
              <div key={agent}>
                <span>
                  <i className="usage-dot" style={{ background: color }} />
                  {label}
                </span>
                <b>{formatMetric(values[cursor] ?? null, metric)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
