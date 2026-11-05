import type { UsageRecord } from '../core/types.js';

/** NEOVERENÉ (docs/log-formats.md): the link between Grok usage and model. */
export function normalizeRecord(record: UsageRecord): UsageRecord {
  if (record.provider !== 'grok-build') return record;
  return { ...record, model: 'unknown', warnings: [...(record.warnings ?? []), 'MODEL_UNVERIFIED'] };
}
