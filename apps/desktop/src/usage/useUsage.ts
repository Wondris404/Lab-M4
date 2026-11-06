import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageItem } from './UsageTab';

export interface Source {
  id: string;
  agent: string;
  name: string;
  /** An approved source which fully covers this one, or null. */
  coveredBy: string | null;
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

export async function fetchUsage(
  sources: Source[],
  request: Request,
  active: () => boolean,
) {
  const records: UsageItem[] = [];
  const warnings: string[] = [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  if (byId.size !== sources.length) throw new Error('Neplatný zoznam zdrojov Usage.');
  for (const source of sources) {
    if (source.coveredBy !== null && typeof source.coveredBy !== 'string')
      throw new Error('Aplikácia nepodporuje bezpečné spracovanie zdrojov Usage.');
    const visited = new Set([source.id]);
    let current = source;
    while (current.coveredBy !== null) {
      const parent = byId.get(current.coveredBy);
      if (!parent || parent.agent !== source.agent || visited.has(parent.id))
        throw new Error('Neplatné prekrytie zdrojov Usage.');
      visited.add(parent.id);
      current = parent;
    }
  }
  if (sources.some((source) => source.coveredBy !== null))
    warnings.push('Prekrývajúce sa zdroje sa započítali iba raz.');
  for (const source of sources) {
    if (source.coveredBy !== null) continue;
    let offset = 0;
    let total = 0;
    let snapshot: string | undefined;
    do {
      if (!active()) return { records, warnings };
      const page = await request<Page>('usage_scan', {
        id: source.id,
        force: false,
        offset,
      });
      const data = page.result;
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
      if (typeof data.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(data.snapshotId))
        throw new Error('Služba Usage nepodporuje bezpečné stránkovanie; zostavte aktuálny sidecar.');
      if (offset === 0) {
        total = data.totalRecords;
        snapshot = data.snapshotId;
        warnings.push(
          ...data.warnings.map((warning) => `${source.agent}: ${warning}`),
        );
        if (data.status !== 'ok')
          warnings.push(
            `${source.agent}: čiastočné alebo nepodporované údaje.`,
          );
      }
      if (data.snapshotId !== snapshot || data.totalRecords !== total)
        throw new Error('Zdroj Usage sa počas stránkovania zmenil; obnovte údaje.');
      if (offset + data.records.length > total)
        throw new Error('Služba Usage vrátila neplatnú stránku.');
      if (!data.records.length && offset < total)
        throw new Error('Služba Usage vrátila neúplnú stránku.');
      records.push(...data.records.slice(0, Math.max(0, total - offset)));
      offset += data.records.length;
    } while (offset < total);
  }
  return { records, warnings };
}

export function useUsage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [records, setRecords] = useState<UsageItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const active = () => generation.current === current;
    setLoading(true);
    setError(undefined);
    try {
      const nextSources = await invoke<Source[]>('usage_list_sources');
      if (!active()) return;
      const result = await fetchUsage(nextSources, invoke, active);
      if (!active()) return;
      setSources(nextSources);
      setRecords(result.records);
      setWarnings(result.warnings);
    } catch (reason) {
      if (active()) setError(String(reason));
    } finally {
      if (active()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

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

  return { sources, records, warnings, loading, error, refresh, addSource };
}
