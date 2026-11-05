import { writeFile, rm } from 'node:fs/promises';
import { testTempDir } from './test-temp.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import example from '../config/settings.example.json';
import { loadSettings, settingsSchema } from '../src/core/settings.js';

describe('settings', () => {
  it('accepts the disabled placeholder configuration', () => {
    expect(settingsSchema.parse(example).agents.codex.enabled).toBe(false);
  });
  it.each([0, -1, Infinity, '1'])('rejects invalid EUR rate %s', (usdToEur) => {
    expect(settingsSchema.safeParse({ ...example, usdToEur }).success).toBe(
      false,
    );
  });
  it('requires a path for enabled agents', () => {
    const data = structuredClone(example);
    data.agents.codex.enabled = true;
    expect(settingsSchema.safeParse(data).success).toBe(false);
  });
  it('rejects negative prices', () => {
    const data = structuredClone(example);
    data.priceTable.REPLACE_WITH_MODEL.standard.inputPerMillion = -1;
    expect(settingsSchema.safeParse(data).success).toBe(false);
  });
  it('requires all four agent entries', () => {
    expect(settingsSchema.safeParse({ ...example, agents: {} }).success).toBe(
      false,
    );
  });
  it('loads only an explicitly supplied settings file', async () => {
    const directory = await testTempDir('lab-m4-test-');
    try {
      const path = join(directory, 'settings.json');
      await writeFile(path, JSON.stringify(example));
      expect(await loadSettings(path)).toEqual(example);
      await writeFile(path, '{broken');
      await expect(loadSettings(path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
