import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clearLegacyFontSize,
  asHexColor,
  DEFAULT_APP_SETTINGS,
  DEFAULT_TERMINAL_COLORS,
  normalizeAppSettings,
  toPersistedSettings,
  withOrchestratorSettings,
  readLegacyFontSize,
  type AiSettings,
  type AppearanceSettings,
  type AppSettings,
  type GeneralSettings,
  type OrchestratorSettings,
  type TerminalColorMode,
  type TerminalColors,
  type SettingsTab,
} from "./types";
import { accentColors, applyThemeToDocument, resolveAppearance, SYSTEM_THEME_QUERY } from "./applyAppearance";
import {
  ensureFontStackReady,
  preloadWebFonts,
  resolveUsableFontStack,
} from "./fonts";
import { getTheme } from "./themes";

const SAVE_DEBOUNCE_MS = 300;

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [ready, setReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(SYSTEM_THEME_QUERY).matches);
  const appearance = resolveAppearance(settings.appearance, systemDark);
  const { globalTheme, terminalTheme } = appearance;
  const { accent } = settings.appearance;
  const { fontFamily } = settings.terminal;

  useEffect(() => {
    const query = window.matchMedia(SYSTEM_THEME_QUERY);
    const sync = () => setSystemDark(query.matches);
    query.addEventListener("change", sync);
    sync();
    return () => query.removeEventListener("change", sync);
  }, []);

  useLayoutEffect(() => {
    applyThemeToDocument(globalTheme, fontFamily);
    const root = document.documentElement.style;
    const light = accentColors(accent, false);
    const dark = accentColors(accent, true);
    const colors = globalTheme === "wraith" ? dark : light;
    root.setProperty("--accent-fill", accent);
    root.setProperty("--accent-ink", colors.foreground);
    root.setProperty("--accent-light", light.readable);
    root.setProperty("--accent-dark", dark.readable);
    root.setProperty("--accent", colors.readable);
    root.setProperty("--accent-hover", colors.readable);
  }, [accent, fontFamily, globalTheme]);

  const settingsRef = useRef(settings);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef(Promise.resolve());

  const persist = useCallback((next: AppSettings) => {
    const save = saveQueueRef.current.then(() =>
      invoke<void>("save_app_settings", { state: toPersistedSettings(next) })
    );
    saveQueueRef.current = save.catch(() => undefined);
    return saveQueueRef.current;
  }, []);

  const schedulePersist = useCallback(
    (next: AppSettings) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void persist(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist]
  );

  const flushPersist = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await persist(settingsRef.current);
  }, [persist]);

  const updateSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings, options?: { persist?: boolean }) => {
      const next = updater(settingsRef.current);
      settingsRef.current = next;
      setSettings(next);
      if (options?.persist !== false) schedulePersist(next);
    },
    [schedulePersist]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next = DEFAULT_APP_SETTINGS;
      try {
        const raw = await invoke<unknown>("load_app_settings");
        if (cancelled) return;
        next = normalizeAppSettings(raw);

        // Frontend-only migration for localStorage font size.
        const legacySize = readLegacyFontSize();
        if (legacySize !== null && next.terminal.fontSize === DEFAULT_APP_SETTINGS.terminal.fontSize) {
          // Prefer legacy size when settings still has the default size and
          // settings.json may have been freshly created without a user font.
          // Always apply legacy if present on first ready so zoom survives upgrade.
          next = {
            ...next,
            terminal: { ...next.terminal, fontSize: legacySize },
          };
          clearLegacyFontSize();
          void persist(next);
        } else if (legacySize !== null) {
          clearLegacyFontSize();
        }

      } catch {
        if (cancelled) return;
      }
      settingsRef.current = next;
      setSettings(next);
      setReady(true);

      // Font preparation may finish after the user changes another setting.
      const savedFont = next.terminal.fontFamily;
      await preloadWebFonts().catch(() => undefined);
      const usable = resolveUsableFontStack(savedFont);
      await ensureFontStackReady(usable).catch(() => undefined);
      if (cancelled || usable === savedFont || settingsRef.current.terminal.fontFamily !== savedFont) return;
      updateSettings((prev) => ({
        ...prev,
        terminal: { ...prev.terminal, fontFamily: usable },
      }));
    })();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [persist, updateSettings]);

  const setTheme = useCallback(
    (theme: AppearanceSettings["theme"]) => {
      updateSettings((prev) => ({
        ...prev,
        appearance: { ...prev.appearance, theme },
        terminal: { ...prev.terminal, colorMode: "theme" },
      }));
    },
    [updateSettings]
  );

  const setAppearance = useCallback(
    (patch: Partial<AppearanceSettings>) => {
      updateSettings((prev) => ({
        ...prev,
        appearance: {
          ...prev.appearance,
          ...patch,
          accent: asHexColor(patch.accent, prev.appearance.accent),
        },
      }));
    },
    [updateSettings]
  );

  const setFontSize = useCallback(
    (fontSize: number) => {
      updateSettings((prev) => ({
        ...prev,
        terminal: { ...prev.terminal, fontSize },
      }));
    },
    [updateSettings]
  );

  const setFontFamily = useCallback(
    (fontFamily: string) => {
      void (async () => {
        const ready = await ensureFontStackReady(fontFamily).catch(
          () => fontFamily
        );
        updateSettings((prev) => ({
          ...prev,
          terminal: { ...prev.terminal, fontFamily: ready },
        }));
      })();
    },
    [updateSettings]
  );

  const setTerminalColorMode = useCallback(
    (colorMode: TerminalColorMode) => {
      updateSettings((prev) => {
        // When switching to custom for the first time, seed from the active theme.
        if (colorMode === "custom" && prev.terminal.colorMode !== "custom") {
          const themeColors = getTheme(terminalTheme).terminal;
          return {
            ...prev,
            terminal: {
              ...prev.terminal,
              colorMode,
              colors: {
                foreground: themeColors.foreground,
                background: themeColors.background,
                cursor: themeColors.cursor,
                selectionBackground:
                  themeColors.selectionBackground ??
                  DEFAULT_TERMINAL_COLORS.selectionBackground,
              },
            },
          };
        }
        return {
          ...prev,
          terminal: { ...prev.terminal, colorMode },
        };
      });
    },
    [terminalTheme, updateSettings]
  );

  const setTerminalColor = useCallback(
    (key: keyof TerminalColors, value: string) => {
      updateSettings((prev) => ({
        ...prev,
        terminal: {
          ...prev.terminal,
          colorMode: "custom",
          colors: {
            ...prev.terminal.colors,
            [key]: value,
          },
        },
      }));
    },
    [updateSettings]
  );

  const resetTerminalColorsFromTheme = useCallback(() => {
    updateSettings((prev) => {
      const themeColors = getTheme(terminalTheme).terminal;
      return {
        ...prev,
        terminal: {
          ...prev.terminal,
          colorMode: "custom",
          colors: {
            foreground: themeColors.foreground,
            background: themeColors.background,
            cursor: themeColors.cursor,
            selectionBackground:
              themeColors.selectionBackground ??
              DEFAULT_TERMINAL_COLORS.selectionBackground,
          },
        },
      };
    });
  }, [terminalTheme, updateSettings]);

  const setAiSettings = useCallback(
    async (ai: AiSettings) => {
      const next: AppSettings = {
        ...settingsRef.current,
        ai: { ...ai },
      };
      settingsRef.current = next;
      setSettings(next);
      await persist(next);
    },
    [persist]
  );

  const setGeneralSettings = useCallback(
    async (general: Partial<GeneralSettings>) => {
      const next: AppSettings = {
        ...settingsRef.current,
        general: {
          ...settingsRef.current.general,
          ...general,
          window: general.window
            ? { ...general.window }
            : { ...settingsRef.current.general.window },
        },
      };
      settingsRef.current = next;
      setSettings(next);
      await persist(next);
    },
    [persist]
  );

  const setSidebarCollapsed = useCallback(
    (sidebarCollapsed: boolean) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarCollapsed,
        },
      }));
    },
    [updateSettings]
  );

  const setSidebarWidth = useCallback(
    (sidebarWidth: number) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarWidth,
        },
      }));
    },
    [updateSettings]
  );

  /** Live resize: collapsed + width in one write (avoids double save thrash). */
  const setSidebarLayout = useCallback(
    (layout: { collapsed: boolean; width?: number }) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          sidebarCollapsed: layout.collapsed,
          sidebarWidth:
            layout.width !== undefined
              ? layout.width
              : prev.general.sidebarWidth,
        },
      }));
    },
    [updateSettings]
  );

  const setWindowGeometry = useCallback(
    (window: AppSettings["general"]["window"]) => {
      updateSettings((prev) => ({
        ...prev,
        general: {
          ...prev.general,
          window: { ...window },
        },
      }));
    },
    [updateSettings]
  );

  const setOrchestratorSettings = useCallback(
    (patch: Partial<OrchestratorSettings>) => {
      updateSettings((prev) => withOrchestratorSettings(prev, patch));
    },
    [updateSettings]
  );

  const openSettings = useCallback(
    (tab: SettingsTab = "appearance") => {
      setSettingsTab(tab);
      setSettingsOpen(true);
    },
    []
  );

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return {
    settings,
    appearance,
    settingsRef,
    ready,
    settingsOpen,
    settingsTab,
    setSettingsTab,
    openSettings,
    closeSettings,
    setTheme,
    setAppearance,
    setFontSize,
    setFontFamily,
    setTerminalColorMode,
    setTerminalColor,
    resetTerminalColorsFromTheme,
    setAiSettings,
    setGeneralSettings,
    setOrchestratorSettings,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarLayout,
    setWindowGeometry,
    updateSettings,
    flushPersist,
  };
}

export type AppSettingsApi = ReturnType<typeof useAppSettings>;
