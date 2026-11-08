import { useState } from "react";
import { asHexColor, DEFAULT_APP_SETTINGS, type AppearanceSettings } from "./types";
import { THEME_LIST } from "./themes";
import type { AppSettingsApi } from "./useAppSettings";

const ACCENTS = [
  ["Fialová", "#8b5cf6"],
  ["Modrá", "#2563eb"],
  ["Zelená", "#15803d"],
  ["Oranžová", "#c2410c"],
] as const;

export function AppearancePanel({ api }: { api: AppSettingsApi }) {
  const { globalTheme, theme, usageTheme, accent } = api.settings.appearance;
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const hex = hexDraft ?? accent;
  const valid = asHexColor(hex, "") !== "";

  function setAccent(value: string) {
    setHexDraft(null);
    api.setAppearance({ accent: value });
  }

  return (
    <div className="settings-section appearance-panel">
      <label>
        Globálna téma
        <select value={globalTheme} onChange={(event) =>
          api.setAppearance({ globalTheme: event.target.value as AppearanceSettings["globalTheme"] })}>
          <option value="system">Podľa systému</option>
          <option value="light">Svetlá</option>
          <option value="dark">Tmavá</option>
        </select>
      </label>
      <label>
        Paleta terminálu
        <select value={theme} onChange={(event) => api.setTheme(event.target.value as AppearanceSettings["theme"])}>
          <option value="inherit">Zdediť globálnu tému</option>
          {THEME_LIST.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {api.settings.terminal.colorMode === "custom" && (
        <p className="settings-section-hint">Terminál používa vlastné farby z karty Terminál.</p>
      )}
      <label>
        Téma Usage
        <select value={usageTheme} onChange={(event) =>
          api.setAppearance({ usageTheme: event.target.value as AppearanceSettings["usageTheme"] })}>
          <option value="inherit">Zdediť globálnu tému</option>
          <option value="light">Svetlá</option>
          <option value="dark">Tmavá</option>
        </select>
      </label>
      <fieldset className="appearance-mode">
        <legend>Akcentová farba</legend>
        <div className="accent-presets">
          {ACCENTS.map(([name, value]) => (
            <button key={value} type="button" aria-pressed={value === accent} onClick={() => setAccent(value)}>
              <span aria-hidden="true" className="accent-swatch" style={{ background: value }} />
              {name}
            </button>
          ))}
        </div>
        <div className="accent-custom">
          <label>Vlastná farba <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} /></label>
          <label>
            HEX
            <input type="text" value={hex} maxLength={7} aria-invalid={!valid}
              aria-describedby="accent-hex-hint"
              onChange={(event) => {
                const value = event.target.value;
                setHexDraft(value);
                if (value.length === 7 && asHexColor(value, "")) api.setAppearance({ accent: value });
              }}
              onBlur={() => { if (valid) setAccent(hex); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && valid) setAccent(hex);
              }}
            />
          </label>
        </div>
        <p className="settings-section-hint" id="accent-hex-hint">
          {valid ? "Formát #RRGGBB alebo #RGB." : "Zadaj platnú HEX farbu."}
        </p>
        <span className="accent-preview">Náhľad akcentu</span>
      </fieldset>
      <button className="appearance-reset" type="button" onClick={() => {
        setHexDraft(null);
        const defaults = DEFAULT_APP_SETTINGS.appearance;
        api.setAppearance({
          globalTheme: defaults.globalTheme,
          usageTheme: defaults.usageTheme,
          accent: defaults.accent,
        });
        api.setTheme(defaults.theme);
      }}>Obnoviť predvolený vzhľad</button>
    </div>
  );
}
