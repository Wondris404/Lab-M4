import { emptyResult, type Parser } from './contracts.js';
import {
  count,
  ExpansionLimitError,
  LineLimitError,
  lines,
  obj,
  str,
  time,
} from './shared.js';

export const grokBuildParser: Parser = {
  provider: 'grok-build',
  async parse(path) {
    const result = emptyResult(),
      models = new Map<string, string>(),
      sessions = new Map<string, string>(),
      seen = new Set<string>();
    try {
      for await (const line of lines(path)) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = obj(JSON.parse(line));
        } catch {
          result.warnings++;
          continue;
        }
        const ctx = obj(event.ctx),
          sid = str(event.sid),
          model =
            str(ctx.model_id) ?? str(ctx.canonical_model) ?? str(ctx.model);
        const session = str(ctx.session_id) ?? str(ctx.sessionId);
        if (sid && session) {
          if (sessions.get(sid) !== session) models.delete(sid);
          sessions.set(sid, session);
        }
        if (sid && model && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(model))
          models.set(sid, model);
        if (event.msg !== 'shell.turn.inference_done') continue;
        const timestamp = time(event.ts),
          inputTokens = count(ctx.prompt_tokens),
          cachedInputTokens = count(ctx.cached_prompt_tokens),
          outputTokens = count(ctx.completion_tokens),
          reasoningTokens = count(ctx.reasoning_tokens);
        if (
          !timestamp ||
          inputTokens === undefined ||
          cachedInputTokens === undefined ||
          outputTokens === undefined ||
          reasoningTokens === undefined ||
          cachedInputTokens > inputTokens ||
          reasoningTokens > outputTokens
        ) {
          result.warnings++;
          continue;
        }
        const fingerprint = JSON.stringify([
          sid ?? 'unknown',
          ctx.loop_index,
          timestamp,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
        ]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        result.records.push({
          provider: 'grok-build',
          sessionId: sid ? (sessions.get(sid) ?? 'unknown') : 'unknown',
          model:
            sid && sessions.has(sid)
              ? (models.get(sid) ?? 'unknown')
              : 'unknown',
          timestamp,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
          speed: 'unknown',
          costSource: 'neznáme',
        });
      }
    } catch (error) {
      if (
        !(error instanceof LineLimitError) &&
        !(error instanceof ExpansionLimitError)
      )
        throw error;
      if (error instanceof ExpansionLimitError) {
        result.records.length = 0;
        result.limits.length = 0;
        result.warnings = 0;
      }
      result.warnings++;
      result.partial = true;
    }
    return result;
  },
};
