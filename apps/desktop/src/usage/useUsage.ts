import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageItem } from './UsageTab';

export interface Source {
  id: string;
  agent: string;
  name: string;
}
interface Page {
  result: {
    status: string;
    totalRecords: number;
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
  for (const source of sources) {
    let offset = 0;
    let total = 0;
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
        data.records.length > 500
      )
        throw new Error('Neplatná odpoveď služby Usage.');
      if (offset === 0) {
        total = data.totalRecords;
        warnings.push(
          ...data.warnings.map((warning) => `${source.agent}: ${warning}`),
        );
        if (data.status !== 'ok')
          warnings.push(
            `${source.agent}: čiastočné alebo nepodporované údaje.`,
          );
      }
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
