# Architektúra kostry agent-usage

## Rozsah

Lokálna kostra pre Windows, Node.js 20+, pnpm a TypeScript v strict režime.
Žiadne prehľadávanie disku, čítanie logov ani reálne údaje.
Aktuálne vetva `feat/skeleton`; zmeny do main zlučuje používateľ.

## Moduly

- `core/types.ts`: spoločný UsageRecord bez promptov, správ či prihlasovacích údajov.
- `core/settings.ts`: explicitné načítanie jedného JSON súboru a validácia cez Zod.
- `parsers/`: rozhranie a register štyroch parserov. Každý zatiaľ vracia prázdne pole bez prístupu k súborom.
- `aggregate/`: budúce zmluvy agregácií a jediný súčasný výpočet celkových tokenov.
- `pricing/`: čistý odhad USD z dodanej tabuľky cien za milión tokenov; neznámy model alebo rýchlosť znamená null.
- `server/`: Hono API iba na 127.0.0.1:3001.
- `web/`: React + Vite + Tailwind, iba nadpis a prázdny stav. Recharts je nainštalovaný, nepoužíva sa.
- `tests/`: ručne vytvorené údaje; žiadne používateľské logy.

## Dátová zmluva

inputTokens zahŕňa cachedInputTokens; outputTokens zahŕňa reasoningTokens.
Spracované tokeny = inputTokens + outputTokens. Podmnožiny sa nepripočítavajú druhýkrát.
Rýchlosť môže byť standard, fast alebo unknown; unknown sa neprekladá na standard.
costUsd je voliteľné; costSource označuje „skutočné“ alebo „odhad“.
Neznáma cena sa neprekladá na nulu. Budúce parsery musia neúplné záznamy riešiť explicitne,
nie dosadzovaním núl. Pred ich implementáciou sa podľa reálnych schém posúdi rozšírenie
tokenových polí o null.

## Tok dát

Teraz: prehliadač → Vite na 127.0.0.1:5173; /api sa proxyuje do Hono.
GET /api/health vracia { status: "ok" }.
GET /api/summary vracia { records: [], totals: null }.
Stránka má statický prázdny stav; server nepoužíva nastavenia ani parsery.

Neskôr: explicitné nastavenia → overený parser → UsageRecord → ceny → agregácie → API → UI.
Skutočná cena z logu bude mať prednosť; výpočet bude označený „odhad“.
EUR prepočet použije používateľom zadaný kurz. Teraz je implementovaná iba čistá USD funkcia.

## Ďalší krok

Samostatne schváliť zisťovanie umiestnení a formátov logov, pripraviť bezpečné testovacie
vzorky a až potom implementovať parsery. Nasledujú inkrementálne čítanie, agregácie,
obnova a dashboard. Žiadny formát logov sa v tejto kostre nepredpokladá.
