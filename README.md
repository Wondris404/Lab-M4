# Agent usage

Malá lokálna kostra dashboardu pre Codex, Grok Build, OpenCode a Antigravity.
Zatiaľ nečíta žiadne logy. Stránka obsahuje iba nadpis a „Zatiaľ žiadne dáta“.

## Spustenie vo Windows

Potrebujete Node.js 20+ a pnpm 10.29.3. V priečinku projektu spustite:

```powershell
pnpm install
pnpm dev
```

Dev príkaz spustí oba procesy a otvorí prehliadač na http://127.0.0.1:5173.
API beží iba na http://127.0.0.1:3001. Ukončenie: Ctrl+C.
Porty 5173 a 3001 musia byť voľné. Inštalácia balíkov potrebuje internet;
samotná kostra aplikácie nevolá externé služby.

## Overenie

```powershell
pnpm test
pnpm lint
pnpm build
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

Health vráti status ok. /api/summary vráti prázdne records a totals: null.
Build vytvorí server v dist/server a statický web v dist/web.
Tento krok obsahuje dev spúšťanie; produkčné servírovanie webu ešte nie je súčasťou kostry.

## Nastavenia a výpočty

config/settings.example.json obsahuje iba zástupné hodnoty. Všetci agenti sú vypnutí,
cesty sú prázdne, kurz 1 a ceny pri REPLACE_WITH_MODEL sú iba ukážka štruktúry,
nie reálny kurz ani cenník. Vlastný config/settings.json je v .gitignore.
Server zatiaľ žiadne nastavenia nenačítava; loadSettings načíta iba výslovne dodaný súbor.

Ceny sú v USD za milión tokenov, osobitne pre standard a fast. Neznámy model alebo
chýbajúca rýchlostná sadzba vracia null. Cached input je súčasť inputTokens a reasoning
súčasť outputTokens, preto sa pri súčtoch ani cenách neúčtujú druhýkrát.
Testy používajú iba ručne vytvorené záznamy.

Stručný návrh modulov a ďalší postup: [architektúra](docs/architecture.md).
