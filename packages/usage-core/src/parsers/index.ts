import type { Provider } from '../core/types.js';
import { codexParser } from './codex.js';
import { grokBuildParser } from './grok-build.js';
import { opencodeParser } from './opencode.js';
import { antigravityParser } from './antigravity.js';

export * from './contracts.js';
import type { Parser } from './contracts.js';
export const parserRegistry: Readonly<Record<Provider, Parser>> = {
  codex: codexParser,
  'grok-build': grokBuildParser,
  opencode: opencodeParser,
  antigravity: antigravityParser,
};
