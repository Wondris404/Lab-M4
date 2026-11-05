# Denník práce

## 2026-11-05 20:04 – Príprava pracovnej kópie
- Branch / commit SHA: `feat/usage-hardening` / `003c1408be4d2611d187cd0fdd51a8590e25d54a` (základ).
- Čo som spravil: Po výslovnom povolení som inicializoval pracovnú kópiu, pripojil `origin`, načítal vetvy a vytvoril pracovnú vetvu z aktuálneho `main`. Prečítal som plán a jeho schvaľovaciu verziu.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `git remote -v`, `git fetch origin`, `git pull --ff-only` úspešné; Node 24.22.1, Corepack 0.36.0, Rust a Cargo 1.97.1, GitHub CLI prihlásené. CI zatiaľ nespustené.
- Problémy / rozhodnutia: V koreňovom priečinku je existujúci nesledovaný vnorený repozitár `agent-usage/`; ponechaný bez zásahu a nestashovaný, aby sa nepresúvali alebo nemazali jeho dáta. Git vyžaduje nastavenie `safe.directory` pre jednotlivé príkazy; globálne nastavenie nemením.
- NEOVERENÉ: Inštalácia závislostí, baseline testy a aplikácia.
- Ďalší krok: Pripraviť projektové cache a spustiť lokálne kontroly.

## 2026-11-05 20:08 – Baseline a limit dekompresie
- Branch / commit SHA: `feat/usage-hardening` / `003c1408be4d2611d187cd0fdd51a8590e25d54a` (základ, zmeny zatiaľ necommitované).
- Čo som spravil: Nainštaloval som závislosti s projektovou cache, pripravil sidecar a začal chrániť zstd sken limitom 256 MiB na súbor a 1 GiB na sken. Pri prekročení sa zasiahnutý súbor nezapočíta a vznikne upozornenie.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `corepack pnpm install --frozen-lockfile` úspešné; koreňové `pnpm test` po zabalení sidecaru 35/35; `pnpm typecheck`, `pnpm lint`, `cargo fmt --all -- --check` úspešné. `pnpm -r test` vynechal koreňové testy, `pnpm -r typecheck` a `pnpm -r lint` nenašli skripty vo vybraných balíkoch. Cielené testy `expansion.test.ts` a `parsers.test.ts`: 13/13. CI zatiaľ nespustené; `cargo clippy` prebieha.
- Problémy / rozhodnutia: Prvý koreňový test pred zabalením sidecaru zlyhal; po `pnpm package:usage-sidecar` prešiel. Globálne `corepack enable` som nespustil, aby sa nemenili systémové nastavenia. Balenie sidecaru pri ďalšom spustení zmaže existujúci generovaný staging; spustenie `tauri dev` vyžaduje vyriešiť výslovný zákaz mazania.
- NEOVERENÉ: GUI, skutočné lokálne logy (sú mimo povoleného priečinka), Rust clippy/testy, append sken a SQLite WAL.
- Ďalší krok: Overiť a odovzdať prvý samostatný krok, potom riešiť inkrementálne skenovanie a SQLite.

## 2026-11-05 20:14 – Ochrana pamäte zstd
- Branch / commit SHA: `feat/usage-hardening` / `0b8d05d` (odoslaný prvý krok; ďalšia zmena pripravená).
- Čo som spravil: Otvoril som koncept PR #10 a doplnil kontrolu hlavičiek všetkých zstd rámcov pred pridelením pamäte dekodérom. Kontrola povoľuje aj zreťazené a preskakovateľné rámce.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm exec vitest run packages/usage-core/tests/expansion.test.ts packages/usage-core/tests/parsers.test.ts` 15/15, vrátane nadmerného okna a zreťazených rámcov; `pnpm exec tsc --noEmit` úspešné. `cargo clippy --all-targets -- -D warnings` úspešné, `cargo test` prebieha. CI PR #10 pre prvý commit: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Prvotný kontrolný limit výstupu sám neobmedzoval pamäť deklarovanú hlavičkou zstd; preto je pred dekodérom nová kontrola okna. Lokálny zabalený sidecar ešte neobsahuje túto zmenu.
- NEOVERENÉ: GUI a sidecar s novým kódom; append sken a WAL zostávajú nedokončené.
- Ďalší krok: Dokončiť kontroly zstd, odoslať a sledovať CI, potom pokračovať vo F3.

## 2026-11-05 20:16 – Neúplný posledný riadok
- Branch / commit SHA: `feat/usage-hardening` / `a0d651c` (odoslané; oprava riadkov pripravená).
- Čo som spravil: Parser odloží posledný riadok JSONL až do ukončujúceho LF, aj keď už tvorí platný JSON. Existujúce testovacie záznamy, ktoré majú predstavovať úplné riadky, teraz LF obsahujú.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): Cielené `expansion.test.ts` a `parsers.test.ts` 16/16; `pnpm exec tsc --noEmit` úspešné. `cargo test` 6/6. CI PR #10 pre `a0d651c`: node úspešné, desktop ešte beží.
- Problémy / rozhodnutia: Ide o prvý krok inkrementálneho skenovania; offsety ani perzistentný stav parserov zatiaľ neexistujú.
- NEOVERENÉ: Balený sidecar s novými zmenami, GUI, reálne logy a živé SQLite WAL.
- Ďalší krok: Overiť lint, odoslať zmenu a pokračovať v implementácii kurzorov.

## 2026-11-05 20:18 – Uzamknutá SQLite
- Branch / commit SHA: `feat/usage-hardening` / `ed09a1a` (odoslané; oprava zámku pripravená).
- Čo som spravil: Čítanie SQLite má krátky busy timeout a najviac tri pokusy pri `SQLITE_BUSY`/`SQLITE_LOCKED`; po vyčerpaní vráti čiastočný výsledok s upozornením. Čiastočný výsledok sa neukladá do cache, aby nezostal po uvoľnení zámku.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `locked-database.test.ts`, `cache.test.ts` a `parsers.test.ts` 16/16; zahŕňa súbežne uzamknutú syntetickú DB, kontrolu názvov zdrojových súborov a opakované čítanie po odomknutí. `pnpm exec tsc --noEmit` úspešné. CI PR #10 pre `ed09a1a`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Existujúca ochrana stále odmieta živé WAL; pretek medzi kontrolou WAL a otvorením DB zostáva nevyriešený, takže táto čiastková zmena nedokončuje bod A.c.
- NEOVERENÉ: Úplné správanie živého WAL bez zápisu do zdroja, GUI a skutočné logy mimo povoleného priečinka.
- Ďalší krok: Overiť lint a odoslať tento samostatný krok; pokračovať s WAL a kurzormi.

## 2026-11-05 20:23 – Kurzor pre Grok JSONL
- Branch / commit SHA: `feat/usage-hardening` / `ebe12d7` (odoslané; kurzor pripravený).
- Čo som spravil: Pre samostatný nekomprimovaný Grok JSONL sa ukladá veľkosť, časy, identita súboru, byte offset, kontrolný odtlačok konca už spracovanej časti a pseudonymizovaný stav parsera. Pri raste sa spracúva iba prípona od posledného dokončeného riadku; zmena identity, skrátenie alebo zmenený overovaný úsek vyvolá úplné načítanie.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm test` 42/42, `pnpm exec tsc --noEmit` a `pnpm lint` úspešné. Sidecarový test používal starší zabalený sidecar. CI PR #10 pre `ebe12d7`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Overenie posledných 4 KiB pred offsetom nepreukazuje nezmenenosť celej staršej časti pri súčasnej úprave súboru a jeho zväčšení. Stav obsahuje iba pseudonymy relácií; test kontroluje neprítomnosť syntetických identifikátorov v cache. Kurzory pre Codex a komprimované súbory zatiaľ chýbajú.
- NEOVERENÉ: Balený sidecar, GUI, živé WAL a reálne logy mimo povoleného priečinka.
- Ďalší krok: Dokončiť regresné testy a odoslať čiastkový krok; pokračovať ostatnými zdrojmi.
