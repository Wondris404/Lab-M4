import type { Parser } from './index.js';

export const opencodeParser: Parser = {
  provider: 'opencode',
  parse: () => {
    // TODO: Implement only after the local log format is verified. No file access yet.
    return Promise.resolve([]);
  },
};
