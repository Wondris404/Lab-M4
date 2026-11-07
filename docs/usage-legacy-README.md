# Lab-M4

Malá lokálna kostra dashboardu pre Codex, Grok Build, OpenCode a Antigravity.
Parsery Codex, Grok Build a OpenCode čítajú lokálne zdroje iba po zapnutí v nastaveniach. Stránka zatiaľ obsahuje iba nadpis a „Zatiaľ žiadne dáta“; výsledky sú dostupné cez API.

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

Health vráti status ok. /api/summary vráti počet záznamov, súčty, varovania, limity a prípadné chyby čítania.
Build vytvorí server v dist/server a statický web v dist/web.
Tento krok obsahuje dev spúšťanie; produkčné servírovanie webu ešte nie je súčasťou kostry.

## Nastavenia a výpočty

config/settings.example.json obsahuje iba zástupné hodnoty. Všetci agenti sú vypnutí,
cesty sú prázdne a ceny pri REPLACE_WITH_MODEL sú iba ukážka štruktúry cenníka.
Výsledky používajú USD. Staršie nastavenie usdToEur sa načíta kvôli kompatibilite a pri výpočte sa nepoužíva. Vlastný config/settings.json je v .gitignore.
Server načíta config/settings.json. Skopírujte settings.example.json na settings.json a zapnite len vybraných agentov s ich cestami. Codex prijíma cestu ku .codex, k sessions, archived_sessions alebo ku konkrétnemu JSONL/JSONL.zst. Grok prijíma cestu k unified.jsonl a OpenCode k opencode.db. Antigravity je zatiaľ stub. Čítanie OpenCode SQLite je vypnuté, kým neexistuje snapshot bez zápisu do zdroja; databáza sa neotvára ani v režime immutable.

Ceny sú v USD za milión tokenov, osobitne pre standard a fast. Neznámy model alebo
chýbajúca rýchlostná sadzba vracia null. Cached input je súčasť inputTokens a reasoning
súčasť outputTokens, preto sa pri súčtoch ani cenách neúčtujú druhýkrát.
Testy používajú iba ručne vytvorené záznamy.

Stručný návrh modulov a ďalší postup: [architektúra](docs/architecture.md).
