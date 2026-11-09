import { createHash } from 'node:crypto';
import { emptyResult, type LimitWindow } from './contracts.js';
import { count, obj, str, time } from './shared.js';

/** Stable encoding of parsed JSON, independent of object property order. */
export function codexTotalSignature(total: Record<string, unknown>): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    return value;
  };
  return JSON.stringify(canonicalize(total));
}

export interface CodexCursorState {
  sessionId?: string;
  model: string;
  speed: 'standard' | 'fast' | 'unknown';
  seen: string[];
}

export function codexAccumulator(
  previous: CodexCursorState | undefined,
  pseudonym: (id: string) => string,
) {
  const result = emptyResult();
  let sessionId = previous?.sessionId;
  let model = previous?.model ?? 'unknown';
  let speed = previous?.speed ?? 'unknown';
  const seen = new Set(previous?.seen);
  const fingerprints: string[] = [];
  function consume(line: string) {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = obj(JSON.parse(line));
    } catch {
      result.warnings++;
      result.partial = true;
      return;
    }
    const payload = obj(event.payload);
    if (event.type === 'session_meta' && !sessionId) {
      // The rollout ID distinguishes forks that share a session ID.
      const id = str(payload.id) ?? str(payload.session_id);
      if (id) sessionId = pseudonym(id);
    }
    if (event.type === 'turn_context') {
      model = str(payload.model) ?? 'unknown';
      speed =
        payload.speed === 'fast' || payload.speed === 'standard'
          ? payload.speed
          : 'unknown';
    }
    if (event.type !== 'event_msg' || payload.type !== 'token_count') return;
    const timestamp = time(event.timestamp),
      info = obj(payload.info);
    const last = obj(info.last_token_usage),
      total = obj(info.total_token_usage);
    const rate = obj(payload.rate_limits);
    const window = (value: unknown): LimitWindow | undefined => {
      const current = obj(value);
      if (
        typeof current.used_percent !== 'number' ||
        typeof current.window_minutes !== 'number' ||
        typeof current.resets_at !== 'number'
      )
        return;
      return {
        used_percent: current.used_percent,
        window_minutes: current.window_minutes,
        resets_at: current.resets_at,
      };
    };
    if (timestamp && sessionId) {
      const primary = window(rate.primary),
        secondary = window(rate.secondary);
      if (primary || secondary)
        result.limits.push({
          timestamp,
          sessionId,
          ...(primary && { primary }),
          ...(secondary && { secondary }),
        });
    }
    if (!payload.info) return;
    const inputTokens = count(last.input_tokens),
      cachedInputTokens = count(last.cached_input_tokens);
    const outputTokens = count(last.output_tokens),
      reasoningTokens = count(last.reasoning_output_tokens);
    if (
      !timestamp ||
      !sessionId ||
      inputTokens === undefined ||
      cachedInputTokens === undefined ||
      outputTokens === undefined ||
      reasoningTokens === undefined ||
      cachedInputTokens > inputTokens ||
      reasoningTokens > outputTokens ||
      !Object.keys(total).length
    ) {
      result.warnings++;
      result.partial = true;
      return;
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([sessionId, codexTotalSignature(total)]))
      .digest('hex');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    fingerprints.push(fingerprint);
    result.records.push({
      provider: 'codex',
      sessionId,
      model,
      timestamp,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      speed,
      costSource: 'neznáme',
    });
  }
  return {
    result,
    consume,
    fingerprints,
    state: (): CodexCursorState => ({
      ...(sessionId && { sessionId }),
      model,
      speed,
      seen: [...seen],
    }),
  };
}
