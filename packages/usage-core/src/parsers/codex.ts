import { emptyResult, type Parser, type LimitWindow } from './contracts.js';
import { count, findCodexFiles, lines, obj, str, time } from './shared.js';

export const codexParser: Parser = {
  provider: 'codex',
  async parse(path) {
    const result = emptyResult();
    const seen = new Map<string, Set<string>>();
    for await (const file of findCodexFiles(path)) {
      let sessionId: string | undefined;
      let model = 'unknown';
      let speed: 'standard' | 'fast' | 'unknown' = 'unknown';
      try {
        for await (const line of lines(file)) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = obj(JSON.parse(line));
          } catch {
            result.warnings++;
            continue;
          }
          const p = obj(event.payload);
          if (event.type === 'session_meta')
            sessionId = str(p.session_id) ?? str(p.id);
          if (event.type === 'turn_context') {
            model = str(p.model) ?? 'unknown';
            speed =
              p.speed === 'fast' || p.speed === 'standard'
                ? p.speed
                : 'unknown';
          }
          if (event.type !== 'event_msg' || p.type !== 'token_count') continue;
          const timestamp = time(event.timestamp),
            info = obj(p.info),
            last = obj(info.last_token_usage),
            total = obj(info.total_token_usage);
          const limit = obj(p.rate_limits);
          const window = (value: unknown): LimitWindow | undefined => {
            const v = obj(value),
              used = v.used_percent,
              minutes = v.window_minutes,
              resets = v.resets_at;
            if (
              typeof used !== 'number' ||
              typeof minutes !== 'number' ||
              typeof resets !== 'number'
            )
              return;
            return {
              used_percent: used,
              window_minutes: minutes,
              resets_at: resets,
            };
          };
          if (timestamp && sessionId) {
            const primary = window(limit.primary),
              secondary = window(limit.secondary);
            if (primary || secondary)
              result.limits.push({
                timestamp,
                sessionId,
                ...(primary && { primary }),
                ...(secondary && { secondary }),
              });
          }
          if (!p.info) continue;
          const inputTokens = count(last.input_tokens),
            cachedInputTokens = count(last.cached_input_tokens),
            outputTokens = count(last.output_tokens),
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
            Object.keys(total).length === 0
          ) {
            result.warnings++;
            continue;
          }
          const signature = JSON.stringify(total);
          const signatures = seen.get(sessionId) ?? new Set<string>();
          if (signatures.has(signature)) continue;
          signatures.add(signature);
          seen.set(sessionId, signatures);
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
      } catch {
        result.warnings++;
        result.partial = true;
      }
    }
    return result;
  },
};
