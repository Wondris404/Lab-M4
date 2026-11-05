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
