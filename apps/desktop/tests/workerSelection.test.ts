import { describe, expect, test } from "vitest";
import { agentLabel, buildRunAgents, providerInfo, toBackendAgent } from "../src/agent/orchestratorProviders";
import { DEFAULT_APP_SETTINGS, type OrchestratorSettings } from "../src/settings/types";

const settings: OrchestratorSettings = {
  manager: { provider: "grok", model: "grok-manager" },
  workerSelection: "auto",
  workerPool: [
    { provider: "codex", model: "" }, { provider: "grok", model: "grok-fast" }, { provider: "opencode", model: "gemini" },
  ],
};

describe("worker selection for a run", () => {
  test("automatic mode hands the orchestrator the whole pool to choose from", () => {
    const agents = buildRunAgents({ settings });
    expect(agents.selection).toBe("auto");
    expect(agents.manager).toEqual(settings.manager);
    expect(agents.workers).toEqual(settings.workerPool);
    expect(agents.workers).not.toBe(settings.workerPool);
  });

  test("automatic mode ignores a stale manual list", () => {
    const agents = buildRunAgents({ settings, manualWorkers: [{ provider: "codex", model: "x" }] });
    expect(agents.workers).toHaveLength(3);
  });

  test("manual mode uses exactly the workers chosen in the window", () => {
    const manualWorkers = [{ provider: "codex" as const, model: "a" }, { provider: "codex" as const, model: "a" }];
    const agents = buildRunAgents({ settings, selection: "manual", manualWorkers });
    expect(agents.selection).toBe("manual");
    expect(agents.workers).toEqual(manualWorkers);
  });

  test("the window can override the default orchestrator for one run", () => {
    const agents = buildRunAgents({ settings, manager: { provider: "opencode", model: "m" } });
    expect(agents.manager).toEqual({ provider: "opencode", model: "m" });
    expect(settings.manager.provider).toBe("grok");
  });

  test("rejects fewer than two workers and caps at eight", () => {
    expect(() => buildRunAgents({ settings, selection: "manual", manualWorkers: [{ provider: "codex", model: "" }] }))
      .toThrow(/aspoň 2/);
    const many = Array.from({ length: 10 }, () => ({ provider: "grok" as const, model: "" }));
    expect(buildRunAgents({ settings, selection: "manual", manualWorkers: many }).workers).toHaveLength(8);
  });

  test("backend payload maps the CLI default model to null", () => {
    expect(toBackendAgent({ provider: "codex", model: "" })).toEqual({ provider: "codex", model: null });
    expect(toBackendAgent({ provider: "grok", model: " grok-4 " })).toEqual({ provider: "grok", model: "grok-4" });
    expect(buildRunAgents({ settings: DEFAULT_APP_SETTINGS.orchestrator }).workers.map(toBackendAgent))
      .toEqual([{ provider: "codex", model: null }, { provider: "grok", model: null }, { provider: "opencode", model: null }]);
  });

  test("labels name the product and model and every vendor has a distinct color", () => {
    expect(agentLabel({ provider: "codex", model: null })).toBe("Codex · predvolený model");
    expect(agentLabel({ provider: "grok", model: "grok-4" })).toBe("Grok Build · grok-4");
    const colors = (["codex", "grok", "opencode"] as const).map((id) => providerInfo(id).color.join());
    expect(new Set(colors).size).toBe(3);
    expect(providerInfo("someone-else").label).toBe("someone-else");
  });
});
