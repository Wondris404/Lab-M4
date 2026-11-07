import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const rate = z.number().finite().nonnegative();
const modelPriceSchema = z
  .object({
    inputPerMillion: rate,
    cachedInputPerMillion: rate,
    outputPerMillion: rate,
  })
  .strict();

const agentSchema = z
  .object({
    enabled: z.boolean(),
    path: z.string(),
  })
  .strict()
  .refine((agent) => !agent.enabled || agent.path.trim().length > 0, {
    message: 'Zapnutý agent musí mať cestu.',
    path: ['path'],
  });

export const settingsSchema = z
  .object({
    agents: z
      .object({
        codex: agentSchema,
        'grok-build': agentSchema,
        opencode: agentSchema,
        antigravity: agentSchema,
      })
      .strict(),
    // Accept old settings files. This number had no FX source or date.
    usdToEur: z.number().finite().positive().optional(),
    priceTable: z.record(
      z
        .object({
          standard: modelPriceSchema.optional(),
          fast: modelPriceSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;
export type PriceTable = Settings['priceTable'];

export async function loadSettings(filePath: string): Promise<Settings> {
  const content = await readFile(filePath, 'utf8');
  return settingsSchema.parse(JSON.parse(content));
}
