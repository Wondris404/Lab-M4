import type { Parser } from './index.js';

export const antigravityParser: Parser = {
  provider: 'antigravity',
  parse: () => {
    // TODO: Implement only after the local log format is verified. No file access yet.
    return Promise.resolve([]);
  },
};
