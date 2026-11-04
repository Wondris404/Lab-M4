import type { Parser } from './index.js';

export const codexParser: Parser = {
  provider: 'codex',
  parse: () => {
    // TODO: Implement only after the local log format is verified. No file access yet.
    return Promise.resolve([]);
  },
};
