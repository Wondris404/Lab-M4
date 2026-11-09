import { expect, it } from "vitest";
import { normalizeAppSettings } from "../../../apps/desktop/src/settings/types";
import { accentColors, resolveAppearance } from "../../../apps/desktop/src/settings/applyAppearance";

it("preserves terminal palettes, custom colors and the Usage override from legacy settings", () => {
  const settings = normalizeAppSettings({
    appearance: { theme: "paper", usageTheme: "dark" },
    terminal: { colorMode: "custom", colors: { background: "#123" } },
  });
  expect(settings.terminal).toMatchObject({ colorMode: "custom", colors: { background: "#112233" } });
  expect(resolveAppearance(settings.appearance, true)).toEqual({
    globalTheme: "wraith", terminalTheme: "paper", usageTheme: "dark",
  });
  expect(normalizeAppSettings({ appearance: { theme: "wraith" } }).appearance.usageTheme).toBe("light");
});

it("restores the new appearance settings and resolves both inherited surfaces against the system", () => {
  const saved = normalizeAppSettings({
    appearance: { globalTheme: "system", accent: "#ABC", appMode: "chat", chatAnimation: "pixel" },
  });
  const restored = normalizeAppSettings(JSON.parse(JSON.stringify(saved)));
  expect(restored.appearance).toMatchObject({ accent: "#aabbcc", appMode: "chat", chatAnimation: "pixel" });
  expect(resolveAppearance(restored.appearance, false)).toEqual({
    globalTheme: "light", terminalTheme: "light", usageTheme: "light",
  });
  expect(resolveAppearance(restored.appearance, true)).toEqual({
    globalTheme: "wraith", terminalTheme: "wraith", usageTheme: "dark",
  });
  expect(normalizeAppSettings({ appearance: { globalTheme: "invalid", accent: "red" } }).appearance)
    .toMatchObject({ globalTheme: "system", accent: "#8b5cf6" });
});

it("keeps foreground text readable on very dark and very light custom accent fills", () => {
  expect(accentColors("#000000", true).foreground).toBe("#fff");
  expect(accentColors("#ffffff", false).foreground).toBe("#000");
  expect(accentColors("#000000", true).readable).not.toBe("rgb(0, 0, 0)");
  expect(accentColors("#ffffff", false).readable).not.toBe("rgb(255, 255, 255)");
});
