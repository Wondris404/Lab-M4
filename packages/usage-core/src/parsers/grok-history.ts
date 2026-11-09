import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { emptyResult } from './contracts.js';
import { assertSafePath, count, lines, obj, str, time } from './shared.js';

export function isGrokHistory(path: string, directory: boolean) {
  return directory || basename(path).toLowerCase() === 'updates.jsonl';
}

export async function* grokHistoryFiles(path: string): AsyncGenerator<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isFile() && isGrokHistory(path, false)) yield path;
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || /auth|credential|token|secret|key|login|\.env/i.test(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* grokHistoryFiles(child);
    else if (entry.isFile() && isGrokHistory(child, false)) yield child;
  }
}

export async function parseGrokHistory(path: string) {
  await assertSafePath(path);
  const result = emptyResult();
  const seen = new Set<string>();
  const warn = () => { result.warnings++; result.partial = true; };
  for await (const file of grokHistoryFiles(path)) {
    try {
      for await (const line of lines(file, undefined, warn)) {
        if (!line.includes('"turn_completed"')) continue;
        let event: Record<string, unknown>;
        try { event = obj(JSON.parse(line)); } catch { warn(); continue; }
        const params = obj(event.params);
        const update = obj(params.update);
        if (update.sessionUpdate !== 'turn_completed') continue;
        if (update.usage == null) continue;
        const sessionId = str(params.sessionId);
        const prompt = str(update.prompt_id);
        const rawTime = event.timestamp;
        const timestamp = time(obj(params._meta).agentTimestampMs)
          ?? time(typeof rawTime === 'number' && rawTime < 1e12 ? rawTime * 1000 : rawTime);
        const usage = obj(update.usage);
        if (!sessionId || !timestamp || !Object.keys(usage).length) { warn(); continue; }
        const key = prompt && JSON.stringify([sessionId, prompt]);
        if (key && seen.has(key)) continue;
        const entries = Object.entries(obj(usage.modelUsage));
        const models: [string, unknown][] = entries.length ? entries : [[str(usage.primaryModelId) ?? 'unknown', usage]];
        let accepted = false;
        for (const [model, raw] of models) {
          const totals = obj(raw);
          const inputTokens = count(totals.inputTokens);
          const outputTokens = count(totals.outputTokens);
          const cachedInputTokens = count(totals.cachedReadTokens ?? 0);
          const reasoningTokens = count(totals.reasoningTokens ?? 0);
          if (inputTokens === undefined || outputTokens === undefined ||
              cachedInputTokens === undefined || reasoningTokens === undefined ||
              cachedInputTokens > inputTokens || reasoningTokens > outputTokens) {
            warn();
            continue;
          }
          if (inputTokens + outputTokens === 0) continue;
          accepted = true;
          const ticks = count(totals.costUsdTicks);
          result.records.push({
            provider: 'grok-build', sessionId, model, timestamp, inputTokens, outputTokens,
            cachedInputTokens, reasoningTokens, speed: 'unknown',
            ...(ticks !== undefined && { costUsd: ticks / 1e10 }),
            costSource: ticks === undefined ? 'neznáme' : 'odhad',
          });
        }
        if (key && accepted) seen.add(key);
      }
    } catch { warn(); }
  }
  return result;
}
