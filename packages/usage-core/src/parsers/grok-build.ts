import { createHash } from 'node:crypto';
import { emptyResult, type Parser } from './contracts.js';
import {
  count,
  assertSafeFile,
  ExpansionLimitError,
  LineLimitError,
  ZstdIntegrityError,
  lines,
  obj,
  str,
  time,
} from './shared.js';

export interface GrokCursorState {
  models: [string, string][];
  sessions: [string, string][];
  seen: string[];
}

/** With a pseudonymizer, persisted state contains no source session identifiers. */
export function grokAccumulator(
  previous?: GrokCursorState,
  pseudonym = (id: string) => id,
) {
  const result = emptyResult();
  const models = new Map<string, string>(previous?.models);
  const sessions = new Map<string, string>(previous?.sessions);
  const seen = new Set<string>(previous?.seen);
  function consume(line: string) {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = obj(JSON.parse(line));
    } catch {
      result.warnings++;
      return;
    }
    const ctx = obj(event.ctx),
      rawSid = str(event.sid),
      sid = rawSid ? pseudonym(rawSid) : undefined,
      model = str(ctx.model_id) ?? str(ctx.canonical_model) ?? str(ctx.model);
    const rawSession = str(ctx.session_id) ?? str(ctx.sessionId);
    const session = rawSession ? pseudonym(rawSession) : undefined;
    if (sid && session) {
      if (sessions.get(sid) !== session) models.delete(sid);
      sessions.set(sid, session);
    }
    if (sid && model && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(model))
      models.set(sid, model);
    if (event.msg !== 'shell.turn.inference_done') return;
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
      return;
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          sid ?? 'unknown',
          // A trace id may later be associated with a different session.
          // Its old events cannot suppress that session's usage.
          (sid && sessions.get(sid)) ?? null,
          ctx.loop_index,
          timestamp,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
        ]),
      )
      .digest('hex');
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    result.records.push({
      provider: 'grok-build',
      sessionId: sid
        ? (sessions.get(sid) ?? pseudonym('unknown'))
        : pseudonym('unknown'),
      ...(sid && sessions.has(sid) ? {} : { sessionKnown: false }),
      model:
        sid && sessions.has(sid) ? (models.get(sid) ?? 'unknown') : 'unknown',
      timestamp,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      speed: 'unknown',
      costSource: 'neznáme',
    });
  }
  return {
    result,
    consume,
    state: (): GrokCursorState => ({
      models: [...models],
      sessions: [...sessions],
      seen: [...seen],
    }),
  };
}

export const grokBuildParser: Parser = {
  provider: 'grok-build',
  async parse(path) {
    await assertSafeFile(path);
    const accumulator = grokAccumulator();
    const result = accumulator.result;
    try {
      for await (const line of lines(path)) accumulator.consume(line);
    } catch (error) {
      if (
        !/\.zst$/i.test(path) &&
        !(error instanceof LineLimitError) &&
        !(error instanceof ExpansionLimitError) &&
        !(error instanceof ZstdIntegrityError)
      )
        throw error;
      if (/\.zst$/i.test(path) || error instanceof ExpansionLimitError) {
        result.records.length = 0;
        result.limits.length = 0;
        result.warnings = 0;
      }
      result.warnings++;
      result.partial = true;
      if (error instanceof ZstdIntegrityError)
        result.warningDetails = ['Zstd checksum nesúhlasí; súbor bol vynechaný.'];
      else if (/\.zst$/i.test(path) && !(error instanceof ExpansionLimitError))
        result.warningDetails = ['Komprimovaný súbor je poškodený alebo neúplný; bol vynechaný.'];
    }
    return result;
  },
};
