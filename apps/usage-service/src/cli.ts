import './local-only.js';
import { parserRegistry } from '../../../packages/usage-core/src/parsers/index.js';

const [agent, source, ...extra] = process.argv.slice(2);
if (extra.length || !source || (agent !== 'codex' && agent !== 'grok-build' && agent !== 'opencode')) {
  process.stderr.write('Použitie: pnpm usage <codex|grok-build|opencode> <cesta>\n');
  process.exitCode = 1;
} else {
  try {
    const parsed = await parserRegistry[agent].parse(source);
    const sum = (field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens') =>
      parsed.records.reduce((total, record) => total + BigInt(record[field]), 0n).toString();
    const result = {
      agent,
      status: parsed.partial ? 'partial' : 'ok',
      records: parsed.records.length,
      inputTokens: sum('inputTokens'),
      cachedInputTokens: sum('cachedInputTokens'),
      outputTokens: sum('outputTokens'),
      reasoningTokens: sum('reasoningTokens'),
      cost: 'unknown',
      warnings: parsed.warnings,
      warningDetails: parsed.warningDetails ?? [],
      mismatchFields: parsed.mismatchFields,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (parsed.partial) process.exitCode = 2;
  } catch {
    process.stderr.write('Zdroj sa nepodarilo bezpečne načítať.\n');
    process.exitCode = 1;
  }
}
