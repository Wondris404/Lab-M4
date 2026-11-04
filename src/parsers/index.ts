import type { Provider, UsageRecord } from '../core/types.js';
import { codexParser } from './codex.js';
import { grokBuildParser } from './grok-build.js';
import { opencodeParser } from './opencode.js';
import { antigravityParser } from './antigravity.js';

export interface Parser {
  readonly provider: Provider;
  parse(path: string): Promise<UsageRecord[]>;
}

export const parserRegistry: Readonly<Record<Provider, Parser>> = {
  codex: codexParser,
  'grok-build': grokBuildParser,
  opencode: opencodeParser,
  antigravity: antigravityParser,
};
