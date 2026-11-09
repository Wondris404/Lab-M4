import { describe, expect, test } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizeOrchestratorSettings,
  toPersistedSettings,
  withOrchestratorSettings,
  type AppSettings,
} from "../src/settings/types";

/** Mirrors `merge_json` in src-tauri/src/lib.rs: objects merge deeply, everything else is replaced. */
function rustMerge(base: unknown, overlay: unknown): unknown {
  if (base && overlay && typeof base === "object" && typeof overlay === "object" && !Array.isArray(base) && !Array.isArray(overlay)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>))
      out[key] = key in out ? rustMerge(out[key], value) : value;
    return out;
  }
  return overlay;
}
const rustDefaults = { version: 1, appearance: { theme: "wraith" }, general: { sidebarWidth: 220 } };

/** save_app_settings → settings.json → load_app_settings → normalize, as the app does on restart. */
function roundTrip(settings: AppSettings, previousFile: unknown = {}): AppSettings {
  const saved = JSON.parse(JSON.stringify(rustMerge(rustMerge(rustDefaults, previousFile), toPersistedSettings(settings))));
  return normalizeAppSettings(rustMerge(rustDefaults, saved));
}

describe("default orchestrator settings", () => {
  test("defaults pick Codex as orchestrator and let it choose from three vendors", () => {
    const { orchestrator } = DEFAULT_APP_SETTINGS;
    expect(orchestrator.manager).toEqual({ provider: "codex", model: "" });
    expect(orchestrator.workerSelection).toBe("auto");
    expect(orchestrator.workerPool.map(({ provider }) => provider)).toEqual(["codex", "grok", "opencode"]);
  });

  test("older settings files without an orchestrator section get the defaults", () => {
    const loaded = normalizeAppSettings({ version: 1, appearance: { appMode: "chat" } });
    expect(loaded.orchestrator).toEqual(DEFAULT_APP_SETTINGS.orchestrator);
    expect(loaded.appearance.appMode).toBe("chat");
  });

  test("a chosen default orchestrator survives save and restart", () => {
    const changed = withOrchestratorSettings(DEFAULT_APP_SETTINGS, {
      manager: { provider: "grok", model: "grok-code-fast-1" },
      workerSelection: "manual",
      workerPool: [{ provider: "opencode", model: "google/gemini-3.1-flash-lite" }, { provider: "codex", model: "" }],
    });
    const restored = roundTrip(changed);
    expect(restored.orchestrator).toEqual(changed.orchestrator);
    expect(restored).toEqual(normalizeAppSettings(toPersistedSettings(changed)));
  });

  test("a shorter worker pool replaces the stored list instead of merging into it", () => {
    const previous = toPersistedSettings(DEFAULT_APP_SETTINGS);
    const shorter = withOrchestratorSettings(DEFAULT_APP_SETTINGS, {
      workerPool: [{ provider: "grok", model: "" }, { provider: "grok", model: "" }],
    });
    expect(roundTrip(shorter, previous).orchestrator.workerPool).toEqual([
      { provider: "grok", model: "" }, { provider: "grok", model: "" },
    ]);
  });

  test("patches keep unrelated settings and other orchestrator fields", () => {
    const next = withOrchestratorSettings(DEFAULT_APP_SETTINGS, { workerSelection: "manual" });
    expect(next.orchestrator.manager).toEqual(DEFAULT_APP_SETTINGS.orchestrator.manager);
    expect(next.terminal).toBe(DEFAULT_APP_SETTINGS.terminal);
    expect(next).not.toBe(DEFAULT_APP_SETTINGS);
    expect(DEFAULT_APP_SETTINGS.orchestrator.workerSelection).toBe("auto");
  });

  test("invalid persisted values fall back field by field", () => {
    const normalized = normalizeOrchestratorSettings({
      manager: { provider: "unknown-vendor", model: "x" },
      workerSelection: "sometimes",
      workerPool: [{ provider: "codex", model: "ok-model" }, { provider: "nope" }, null, "grok"],
    });
    expect(normalized.manager).toEqual(DEFAULT_APP_SETTINGS.orchestrator.manager);
    expect(normalized.workerSelection).toBe("auto");
    // Only one valid worker remains, below the minimum of two: use the default pool.
    expect(normalized.workerPool).toEqual(DEFAULT_APP_SETTINGS.orchestrator.workerPool);
  });

  test("model ids are trimmed and unsafe values are dropped; pools are capped at eight", () => {
    const normalized = normalizeOrchestratorSettings({
      manager: { provider: "opencode", model: "  anthropic/claude-sonnet  " },
      workerPool: Array.from({ length: 11 }, (_, index) => ({ provider: "grok", model: index === 0 ? "bad\u001b[31m" : `m${index}` })),
    });
    expect(normalized.manager.model).toBe("anthropic/claude-sonnet");
    expect(normalized.workerPool).toHaveLength(8);
    expect(normalized.workerPool[0].model).toBe("");
    expect(normalizeOrchestratorSettings({ manager: { provider: "codex", model: "a b" } }).manager.model).toBe("");
    expect(normalizeOrchestratorSettings({ manager: { provider: "codex", model: "x".repeat(201) } }).manager.model).toBe("");
  });

  test("persisted payload never contains an API key and copies the pool", () => {
    const payload = toPersistedSettings(DEFAULT_APP_SETTINGS);
    expect(JSON.stringify(payload.orchestrator)).not.toMatch(/key|token|secret/i);
    expect(payload.orchestrator.workerPool).not.toBe(DEFAULT_APP_SETTINGS.orchestrator.workerPool);
  });
});
