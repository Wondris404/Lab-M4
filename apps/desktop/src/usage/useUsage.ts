import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageItem } from './UsageTab';

export interface Source {
  id: string;
  agent: string;
  name: string;
  automatic: boolean;
  enabled: boolean;
  coveredBy?: string | null;
}
interface Page {
  result: {
    status: string;
    totalRecords: number;
    offset: number;
    snapshotId: string;
    records: UsageItem[];
    warnings: string[];
  };
}
export type Request = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type SourceResult = { records: UsageItem[]; warnings: string[] };

function visibleResults(sources: Source[], results: Map<string, SourceResult>) {
  const shown = sources
    .filter(
      (source) =>
        source.enabled && (!source.coveredBy || !results.has(source.coveredBy)),
    )
    .flatMap((source) => results.get(source.id) ?? []);
  return {
    records: shown.flatMap((result) => result.records),
    warnings: shown.flatMap((result) => result.warnings),
  };
}

export async function fetchUsage(
  sources: Source[],
  request: Request,
  active: () => boolean,
  onProgress?: (records: UsageItem[], warnings: string[]) => void,
  results = new Map<string, SourceResult>(),
) {
  const warnings: string[] = [];
  const scanned = new Set<string>();
  const collect = () => {
    const visible = visibleResults(sources, results);
    return {
      records: visible.records,
      warnings: [...visible.warnings, ...warnings],
    };
  };
  for (const source of sources) {
    if (!active()) break;
    if (!source.enabled) continue;
    if (source.coveredBy && scanned.has(source.coveredBy)) {
      scanned.add(source.id);
      continue;
    }
    try {
      const result = await scanSource(source, request, active);
      if (!result) break;
      results.set(source.id, result);
      scanned.add(source.id);
    } catch (reason) {
      if (!active()) break;
      const detail =
        reason instanceof Error
          ? reason.message
          : 'Zdroj sa nepodarilo prečítať.';
      const retained = results.has(source.id)
        ? ' Zobrazujem posledné uložené údaje.'
        : '';
      warnings.push(`${source.agent} (${source.name}): ${detail}${retained}`);
    }
    if (active() && onProgress) {
      const current = collect();
      onProgress(current.records, current.warnings);
    }
  }
  return collect();
}

async function scanSource(
  source: Source,
  request: Request,
  active: () => boolean,
  saved = false,
) {
  const records: UsageItem[] = [];
  const warnings: string[] = [];
  let offset = 0;
  let total = 0;
  let snapshot: string | undefined;
  do {
    if (!active()) return;
    const page = await request<Page | null>('usage_scan', {
      id: source.id,
      force: false,
      offset,
      ...(saved && { saved: true }),
    });
    if (saved && offset === 0 && page === null) return;
    const data = page?.result;
    if (
      !data ||
      !Array.isArray(data.records) ||
      !Array.isArray(data.warnings) ||
      !Number.isSafeInteger(data.totalRecords) ||
      data.totalRecords < 0 ||
      data.offset !== offset ||
      data.records.length > 500
    )
      throw new Error('Neplatná odpoveď služby Usage.');
    if (
      typeof data.snapshotId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.snapshotId)
    )
      throw new Error(
        'Služba Usage nepodporuje bezpečné stránkovanie; zostavte aktuálny sidecar.',
      );
    if (offset === 0) {
      total = data.totalRecords;
      snapshot = data.snapshotId;
      warnings.push(
        ...data.warnings.map((warning) => `${source.agent}: ${warning}`),
      );
      if (data.status !== 'ok')
        warnings.push(`${source.agent}: čiastočné alebo nepodporované údaje.`);
    }
    if (data.snapshotId !== snapshot || data.totalRecords !== total)
      throw new Error(
        'Zdroj Usage sa počas stránkovania zmenil; obnovte údaje.',
      );
    if (offset + data.records.length > total)
      throw new Error('Služba Usage vrátila neplatnú stránku.');
    if (!data.records.length && offset < total)
      throw new Error('Služba Usage vrátila neúplnú stránku.');
    records.push(...data.records.slice(0, Math.max(0, total - offset)));
    offset += data.records.length;
  } while (offset < total);
  return { records, warnings };
}

export async function loadUsage(
  request: Request,
  active: () => boolean,
  onSources?: (sources: Source[]) => void,
  onProgress?: (records: UsageItem[], warnings: string[]) => void,
) {
  const sources = await request<Source[]>('usage_list_sources');
  if (active()) onSources?.(sources);
  const saved = new Map<string, SourceResult>();
  const savedSources = sources.filter((source) => source.enabled);
  await Promise.all(
    savedSources.map(async (source) => {
      try {
        const result = await scanSource(source, request, active, true);
        if (result) saved.set(source.id, result);
      } catch {
        // A missing or damaged saved view never blocks a fresh scan.
      }
    }),
  );
  if (active() && onProgress) {
    const previous = visibleResults(sources, saved);
    onProgress(previous.records, previous.warnings);
  }
  return {
    sources,
    ...(await fetchUsage(sources, request, active, onProgress, saved)),
  };
}

export function useUsage(visible: boolean) {
  const [sources, setSources] = useState<Source[]>([]);
  const [records, setRecords] = useState<UsageItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const current = ++generation.current;
    const active = () => generation.current === current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await loadUsage(
        invoke,
        active,
        setSources,
        (nextRecords, nextWarnings) => {
          setRecords(nextRecords);
          setWarnings(nextWarnings);
        },
      );
      if (!active()) return;
      setRecords(result.records);
      setWarnings(result.warnings);
    } catch (reason) {
      if (active()) setError(String(reason));
    } finally {
      if (active()) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      generation.current++;
      refreshing.current = false;
    };
  }, []);

  useEffect(() => {
    if (visible) void refresh();
  }, [refresh, visible]);

  const addSource = useCallback(
    async (agent: string, folder: boolean) => {
      setError(undefined);
      try {
        const selected = await invoke<Source | null>('usage_select_source', {
          agent,
          folder,
        });
        if (selected) await refresh();
      } catch (reason) {
        setError(String(reason));
      }
    },
    [refresh],
  );

  const changeSource = useCallback(
    async (source: Source) => {
      setError(undefined);
      try {
        if (source.automatic) {
          await invoke('usage_set_auto_source', {
            id: source.id,
            enabled: !source.enabled,
          });
        } else {
          await invoke('usage_remove_source', { id: source.id });
        }
        await refresh();
      } catch (reason) {
        setError(String(reason));
      }
    },
    [refresh],
  );

  return {
    sources,
    records,
    warnings,
    loading,
    error,
    refresh,
    addSource,
    changeSource,
  };
}
