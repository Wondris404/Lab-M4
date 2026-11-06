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

## 2026-11-05 20:25 – Zlúčenie main do Usage UI
- Branch / commit SHA: `feat/usage-ui` / `7fb0e6b9501a5f2cf27b34be59a1856dc5e217e8`.
- Čo som spravil: Zlúčil som `origin/main` do existujúcej vetvy F4 riadnym merge commitom. Merge prešiel bez konfliktov; základný kód F3 zostal zachovaný.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `git diff --name-status --diff-filter=D origin/main feat/usage-ui` nevrátil žiadny súbor. `git diff origin/main feat/usage-ui --stat`:

  ```text
   apps/desktop/src/main.tsx                | 20 ++++++++++-----
   apps/desktop/src/usage/UsageTab.tsx      | 43 ++++++++++++++++++++++++++++++++
   apps/desktop/src/usage/csv.ts            | 11 ++++++++
   apps/desktop/src/usage/format.ts         | 18 +++++++++++++
   apps/desktop/src/usage/usage.css         | 14 +++++++++++
   packages/usage-core/tests/csv.test.ts    |  7 ++++++
   packages/usage-core/tests/format.test.ts | 13 ++++++++++
   7 files changed, 120 insertions(+), 6 deletions(-)
  ```

- Problémy / rozhodnutia: Zmeny F3 hardening zatiaľ nie sú na `main`; po ich používateľskom zlúčení bude potrebné `main` znova zlúčiť do F4. Vnorený `agent-usage/` aj generované Tauri permissions zostali nesledované a nedotknuté.
- NEOVERENÉ: F4 je stále iba počiatočné UI; napojenie a požadované stavy treba dokončiť. CI po odoslaní.
- Ďalší krok: Odoslať merge, nastaviť základ PR #9 na `main` a preskúmať reálne Tauri rozhranie.

## 2026-11-05 20:30 – Napojenie Usage na backend
- Branch / commit SHA: `feat/usage-ui` / `ec033d4` (merge a denník odoslané; UI zmena pripravená).
- Čo som spravil: PR #9 má základ `main`. Usage používa reálne Tauri príkazy na výber zdrojov, zoznam a stránkované skenovanie; zobrazuje filtre, denné hodnoty, súčty, triediteľnú tabuľku, upozornenia, načítanie/prázdny/chybový stav a CSV aktuálneho výberu. Oprávnenia AppManifest a capability obsahujú iba tri používané Usage príkazy.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm test` 41/41 vrátane `usage-ui.test.ts`, `format.test.ts`, `csv.test.ts`; `pnpm typecheck`, `pnpm lint`, `cargo fmt --all -- --check`, `cargo check` a `cargo clippy --all-targets -- -D warnings` úspešné. Test sidecaru používa skôr zabalenú verziu z `main`. CI PR #9 pre `ec033d4`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Backend neposkytuje overenú cenu v EUR; UI ju nevymýšľa. UI testy overujú stavovú a dátovú logiku, nie vykreslenie vo WebView. Opätovné balenie alebo `pnpm tauri dev` by zmazalo existujúci generovaný sidecar, čo vyžaduje povolenie podľa zadania.
- NEOVERENÉ: Skutočná aplikácia, zhoda reálnych súčtov, CSP vo WebView a F3 hardening po zlúčení do `main`.
- Ďalší krok: Odoslať a overiť CI, dokončiť F3 a po jeho zlúčení preniesť `main` do F4.

## 2026-11-05 20:34 – Kurzor pre samostatný Codex JSONL
- Branch / commit SHA: `feat/usage-hardening` / `41cf6fb` (odoslané; rozšírenie kurzora pripravené).
- Čo som spravil: Rovnaký mechanizmus kurzora teraz používa aj samostatný nekomprimovaný Codex JSONL. Stav používa pseudonym relácie a odtlačky deduplikácie; výpočet zachováva `last_token_usage` a rate-limit záznamy.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm test` 43/43 vrátane `codex-cursor.test.ts`, `grok-cursor.test.ts`, parserov a zámku SQLite; `pnpm exec tsc --noEmit` úspešné. Prvý `pnpm lint` odhalil nepoužité premenné v teste, upravené pred odoslaním. CI PR #10 pre `41cf6fb`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Samostatný inkrementálny parser má porovnávací test proti existujúcemu plnému parseru. Obmedzenie kontroly 4 KiB z predchádzajúceho zápisu stále platí. Adresárový Codex sken a komprimované súbory sa naďalej spracúvajú celé.
- NEOVERENÉ: Integračný test nového zabaleného sidecaru, živé WAL a skutočné logy mimo povoleného priečinka.
- Ďalší krok: Overiť lint, odoslať krok, pokračovať v riešení adresárov a WAL.

## 2026-11-05 20:37 – Inkrementálne adresáre Codex
- Branch / commit SHA: `feat/usage-hardening` / `f4ed11c` (odoslané; adresárové rozšírenie pripravené).
- Čo som spravil: Codex adresár uchováva kurzory jednotlivých JSONL súborov a spája výsledky s deduplikáciou podľa pseudonymnej relácie a kumulatívneho podpisu. Zstd archívy číta celé s hranicami rozbalenia; medzi archívmi a JSONL sa duplicitné spotreby nezapočítajú.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm test` 44/44 vrátane `codex-directory.test.ts` (append, neúplný riadok, presun súboru, duplicita JSONL/zstd, porovnanie s úplným parserom); `pnpm exec tsc --noEmit`, `pnpm lint` úspešné. CI PR #10 pre `f4ed11c`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Cache ukladá iba odtlačky a pseudonymy, nie zdrojové relácie. Vzorkovanie predchádzajúceho úseku má obmedzenie uvedené vyššie; komprimované súbory sa vždy znova dekódujú.
- NEOVERENÉ: Nový zabalený sidecar, reálne logy a bezvýhradné no-write čítanie živého WAL.
- Ďalší krok: Odoslať krok, dokončiť bezpečné WAL a vyčkať na povolenie pre manuálne testovanie.

## 2026-11-05 20:38 – Upozornenie na živé WAL
- Branch / commit SHA: `feat/usage-hardening` / `f4ed11c` (ďalšie zmeny pripravené).
- Čo som spravil: Ak sú pri SQLite prítomné WAL alebo SHM súbory, parser aj cache vrátia čiastočný výsledok s upozornením namiesto chyby; zdroj sa neotvára a čiastočný výsledok sa neukladá do cache.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm test` 44/44 vrátane syntetického testu so súbežným zapisovačom a kontroly obsahu DB/WAL/SHM a zoznamu súborov pred a po; `pnpm lint` a `pnpm exec tsc --noEmit` úspešné. CI posledného odoslaného commitu: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: Živé WAL sa zámerne nezapočíta, pretože stále neexistuje preukázaný bezvýhradný no-write postup; pretek medzi kontrolou súborov a otvorením DB zostáva. Nejde o plné dokončenie A.c.
- NEOVERENÉ: Úplné čítanie živého WAL, reálne lokálne logy a GUI.
- Ďalší krok: Dokončiť lokálne testy, odoslať zmeny a pokračovať v bezpečnom riešení SQLite.

## 2026-11-05 20:40 – Lokálne súčty a zabalený sidecar
- Branch / commit SHA: `feat/usage-hardening` / `0eca0d2`.
- Čo som spravil: Po výslovnom povolení som znovu vytvoril generovaný sidecar a jednorazovo otestoval miestne zdroje; zaznamenávam len číselné súčty. Hodnoty sú okamžitý stav v čase testu, pričom cache a reasoning sú podmnožiny, nie ďalšie tokeny na sčítanie.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): `pnpm package:usage-sidecar` úspešné; `sidecar.test.ts`, `codex-directory.test.ts`, `locked-database.test.ts` 3/3. Codex: 3207 záznamov, vstup 614258289, výstup 868177, cache 593283840, reasoning 272234; výsledok čiastočný, 1 kategória upozornení. Grok: 1107 záznamov, vstup 203555613, výstup 932624, cache 190199808, reasoning 573882; bez upozornení. CI pre `0eca0d2`: node úspešné, desktop prebieha.
- Problémy / rozhodnutia: OpenCode má aktívny SQLite žurnál, preto som zdroj neotvoril a súčet nevypočítal; neuvádzam ho ako nulu. Pri čiastočnom výsledku Codex sa stránkovanie môže medzi volaniami zmeniť, preto čísla nemožno považovať za úplné alebo nemenné.
- NEOVERENÉ: OpenCode a úplnosť Codex súčtu; GUI, CSP a živé WAL no-write.
- Ďalší krok: Overiť desktop na vetve F4 v izolovanom aplikačnom profile a dokončiť F3.

## 2026-11-05 20:43 – Spustenie desktopu
- Branch / commit SHA: `feat/usage-ui` / `9e76de8`.
- Čo som spravil: Po povolení opätovného vytvorenia generovaného sidecaru som spustil `pnpm tauri dev` s aplikačným profilom v repozitári.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): Vite a Rust build prešli, proces sa spustil a zoznam okien uviedol jedno okno s titulkom `Lab-M4`. PR #9: node úspešné, desktop CI ešte beží.
- Problémy / rozhodnutia: Automatická kontrola computer-use odmietla prístup k aplikácii Wraith/Lab-M4; nástroj neuviedol podrobnejší dôvod. Z toho dôvodu neboli vykonané ďalšie GUI akcie.
- NEOVERENÉ: Obsah okna, terminálový príkaz `Get-Date`, About, Usage, zhoda súčtov a CSP konzola. Backendové súčty a ich obmedzenia sú zapísané na vetve F3.
- Ďalší krok: Dokončiť F3 a po používateľskom zlúčení `main` doťahovať do F4; manuálnu kontrolu GUI vykonať po sprístupnení aplikácie computer-use alebo používateľom.

## 2026-11-05 20:45 – Odovzdanie priebežného stavu
- Branch / commit SHA: F3 `feat/usage-hardening` / `a084cbd3d900dcb807858e231cec72a3fad11753`, [koncept PR #10](https://github.com/Wondris404/Lab-M4/pull/10); F4 `feat/usage-ui` / `c4a48fa4badcda86b2beba0b7e1093d9d74b571a`, [koncept PR #9](https://github.com/Wondris404/Lab-M4/pull/9). Uvedené SHA sú stav pred týmto odovzdávacím zápisom; aktuálny HEAD je dostupný v PR.
- Čo som spravil: F3 má obmedzené rozbalenie a okno zstd, kurzory JSONL Codex/Grok, obmedzené opakovanie pri SQLite zámku a čiastočné upozornenie na WAL. F4 obsahuje merge `main`, reálne Tauri príkazy, filtre, graf, tabuľku, stavy a export. PR #9 aj #10 sú koncepty so základom `main`; do `main` som nič neposlal ani nezlúčil. F5–F7 som nezačal, pretože podmienka dokončeného a zeleného F3/F4 nie je splnená.
- Ako som to otestoval (príkazy + výsledok, lokálne na PC aj CI): F3 `pnpm test` 44/44, F4 41/41, `pnpm typecheck`, `pnpm lint`, Rust fmt, clippy a Rust testy 6/6; po opätovnom zabalení F3 prešiel aj `sidecar.test.ts`. Testy zahŕňajú `expansion.test.ts`, `codex-cursor.test.ts`, `codex-directory.test.ts`, `grok-cursor.test.ts`, `locked-database.test.ts`, `parsers.test.ts`, `usage-ui.test.ts`, `format.test.ts` a `csv.test.ts`. Node CI pred týmto zápisom úspešné, desktop CI bežalo; každý nový push spúšťa nové kontroly.
- Dôkaz F4: Pri `c4a48fa` mal `git diff origin/main feat/usage-ui --stat` 13 súborov, 698 pridaných a 7 odstránených riadkov; `git diff --name-status --diff-filter=D origin/main feat/usage-ui` nevrátil odstránený súbor. Úplný výpis pôvodného merge je vyššie v denníku; ďalšie riadky denníka tento stat prirodzene zväčšia.
- Problémy / rozhodnutia: F3 kontroluje len posledných 4 KiB pred kurzorom, čo nedokazuje nemennosť celého staršieho obsahu. Aktívne WAL sa nezapočíta; zostáva pretek medzi kontrolou WAL a otvorením databázy. Používateľ povolil opätovné vytvorenie generovaného sidecaru a čítanie miestnych súčtov. Vnorený `agent-usage/` a automaticky generované Tauri permissions zostali nesledované a nedotknuté.
- NEOVERENÉ: Kompletný Codex súčet (sken čiastočný), OpenCode (aktívny žurnál), skutočný obsah okna, PowerShell `Get-Date`, About, Usage a CSP konzola. Automatická kontrola computer-use odmietla prístup k oknu Wraith/Lab-M4 bez podrobnejšieho dôvodu.
- Ďalší krok: Dokončiť no-write správanie SQLite/WAL, presnejšie overenie zmien pred kurzorom a výsledky CI; po schválení a používateľskom zlúčení F3 znova zlúčiť `main` do F4. V `C:\Users\ondre\Desktop\Lab-M4` spustiť `corepack pnpm install --frozen-lockfile` a `corepack pnpm tauri dev`; v okne overiť PowerShell `Get-Date`, About „Based on Wraith“, potom Usage → pridať zdroj → skontrolovať čísla, filtre, graf, triedenie, CSV a konzolu CSP. Až po zelenom F3/F4 začať F5–F7.

## 2026-11-06 08:35 +01:00 (Europe/Bratislava) – Inventúra a poškodený archív
- Vetva: `feat/usage-hardening`; predchádzajúci implementačný HEAD `83d147d1096cad2e5ab3879d0df135c5badc466f`. Predbežný lokálny remote-tracking ukazoval rovnaké SHA; aktuálny serverový stav sa nedal načítať.
- Zmena: Plný Codex parser pri chybe súboru zahodí všetky jeho už prečítané záznamy, limity a deduplikačné podpisy a označí výsledok ako čiastočný. Doplnený syntetický test zreťazeného platného a skráteného zstd rámca.
- Kontroly: `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit`, `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` a `git diff --check` prešli. Samostatne preložený parser na natívnom Windows prešiel syntetickou skúškou platného a skráteného archívu. `pnpm.cmd test` zlyhal pri načítaní konfigurácie: esbuild hlásil `Access is denied` k nadradenému adresáru; celá sada teda neprešla. Node 24.22.1, pnpm 10.29.3, Rust/Cargo 1.97.1, Codex 0.166.0, Grok Build 1.0.70.
- Problémy / rozhodnutia: `git fetch origin` aj `gh` odmietlo sieťové oprávnenie; aktuálne PR a CI nemožno overiť, starý stav CI sa nepovažuje za aktuálny. `feat/usage-ui` má lokálny HEAD `6aa95cfc72e091245fb7ddc29e6c5b11bfb14278`; simulovaný merge s hardening indikuje konflikt v denníku. Nesledovaný vnorený `agent-usage/` a generované Tauri permissions zostali zachované. Pred buildom treba zabrániť prepísaniu týchto existujúcich súborov.
- Audit: SQLite stále obsahuje pretek medzi kontrolou a vznikom WAL; kurzor kontroluje len koncových 4 KiB pred offsetom. Codex deduplikácia závisí od poradia kľúčov JSON. UI môže duplicitne zarátať prekrývajúce sa zdroje a stránkovanie bez snapshotu môže pri zmenách vynechať alebo zopakovať záznamy. Grok `agent stdio` a Codex app-server sú kandidátne transporty; ich požadované approval hranice nie sú dokázané. Žiadny worker nebol spustený.
- NEOVERENÉ: úplné testy a build, živé WAL bez zápisov, tri chránené Wraith súbory, runtime terminálu/About/CSP, aktuálne GitHub PR/CI, licencia a pripnutá verzia upstreamu, orchestrátor, approval/STOP/budget a skutočný manažérsky cyklus.
- Ďalší krok: Po obnovení prístupov najprv dokončiť syntetické testy a overiť stav GitHubu; potom opraviť WAL, kurzory a deduplikáciu, zosúladiť UI pri zachovaní oboch denníkov a vykonať bezpečnostný spike orchestrácie.

### Pokračovanie
- Aktuálna vetva `feat/usage-hardening`; posledné lokálne známe odoslané SHA `83d147d1096cad2e5ab3879d0df135c5badc466f`. Stav servera a prípadný nový commit treba znovu overiť.
- V `<repo>`: `git status --short --branch`, `git fetch origin`, `pnpm.cmd test`, `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit`; potom skontrolovať PR #10 a CI pre presné SHA. Nevykonávať destruktívne čistenie ani neprepisovať existujúce nesledované súbory.

## 2026-11-06 08:40 +01:00 (Europe/Bratislava) – Podpisy Codex súčtov
- Vetva `feat/usage-hardening`; predchádzajúci lokálny commit `a69e7a4191a7ff5feae84db4e0597b98128404c0` opravuje neúplné archívy. Posledný známy remote-tracking SHA je `83d147d1096cad2e5ab3879d0df135c5badc466f`; serverový stav je NEOVERENÝ pre sieťový blok.
- Zmena: Podpisy kumulatívnych Codex údajov nezávisia od poradia kľúčov JSON. Plný aj inkrementálny parser používajú rovnakú kanonizáciu; verzia kurzorov a cache sa zvýšila, takže staré podpisy neostanú v používaní. Pridaný syntetický regresný test pre append aj dva súbory.
- Kontroly: `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit` a `git diff --check` prešli. Samostatne preložený parser a cache prešli na Windows syntetickou skúškou opakovaného snapshotu s prehodeným poradím kľúčov, appendu a deduplikácie medzi súbormi. Úplná sada `pnpm.cmd test`, CI a aplikácia ostávajú NEOVERENÉ z dôvodov v predošlom zázname.
- Ďalší krok: Po obnovení prístupov overiť aktuálne vetvy a CI, spustiť úplnú sadu testov, následne dokončiť bezpečný WAL, spoľahlivé rozpoznanie zmien pred kurzorom a zostávajúce body zadania. Aktuálny stav a lokálne commity overiť cez `git status --short --branch` a `git log -2 --oneline`; pred pushom overiť cieľovú feature vetvu a nezasiahnuť `main`.

## 2026-11-06 08:44 +01:00 (Europe/Bratislava) – Overenie prefixu kurzora
- Vetva `feat/usage-hardening`; predchádzajúci lokálny commit `5096b5229fab3cd3b0c6d6bdaba0f413d9d481d7` opravil deduplikáciu snapshotov. Posledný známy vzdialený tracking SHA `83d147d1096cad2e5ab3879d0df135c5badc466f`; skutočný serverový stav a CI NEOVERENÉ pre sieťový blok.
- Zmena: Pred použitím výsledkov kurzora sa teraz streamovo kontroluje hash celého spracovaného prefixu namiesto posledných 4 KiB; zmena staršieho obsahu vynúti nové parsovanie. Staré kurzory majú nové verzie. Pribudol syntetický test prepisu staršej časti s následným appendom.
- Kontroly: `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit`, `git diff --check` a samostatná syntetická Windows skúška prepisu, appendu a opakovaného čítania prešli. Celý `pnpm.cmd test` zostáva NEOVERENÝ pre vyššie uvedenú chybu prístupu esbuildu.
- Rozhodnutie: Bez dôveryhodného dôkazu append-only nemožno kontrolou samotných metadát a malej vzorky dokázať nezmenený prefix. Parser pri bezpečnom raste znovu parsuje iba príponu, ale predtým číta celý starý prefix na výpočet hashu; požiadavka čítať iba nové bajty preto nie je úplne splnená. Výkonnosť veľkých logov a súbežné zmeny počas čítania treba ďalej testovať.
- NEOVERENÉ: SQLite WAL/no-write pretek, kompletné testy, balenie a beh aplikácie, GitHub CI a celý orchestrátor. Pôvodné nesledované dáta zostávajú zachované.
- Ďalší krok: V `<repo>` spustiť `git status --short --branch`, po obnovení GitHub prístupu `git fetch origin`, `pnpm.cmd test`, `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit`; overiť lokálny HEAD a serverový SHA, potom poslať iba feature vetvu. Pokračovať WAL, UI a overením approval protokolov.

## 2026-11-06 09:48 +01:00 (Europe/Bratislava) – Bezpečná hranica SQLite
- Vetva `feat/usage-hardening`; predchádzajúci lokálny commit `5259701a3bd81f6e948587cd96974c39e5d848c2`. Posledný známy tracking SHA `83d147d1096cad2e5ab3879d0df135c5badc466f`; `git fetch` a `gh` opäť odmietlo sieťové oprávnenie, aktuálny server a CI sú NEOVERENÉ.
- Zmena: OpenCode parser aj cache dočasne odmietajú čítať všetky SQLite databázy a vrátia čiastočný stav s vysvetlením, pretože otvorenie read-only môže vytvoriť alebo zmeniť SHM a kontrola WAL pred otvorením má pretek. Starý úplný výsledok cache sa nesmie vydávať za aktuálny. Súhrn označuje agregáty obsahujúce čiastočné zdroje ako neúplné.
- Kontroly: `pnpm.cmd exec vitest run --configLoader runner` prešlo 50/50 vrátane syntetických testov zámku a WAL, `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests` a `pnpm.cmd exec tsc --noEmit` prešli. Predvolený `pnpm.cmd test` stále zlyháva na prístupovej chybe esbuild loadera. Existujúci sidecar používaný integračným testom nemusí obsahovať najnovší kód.
- NEOVERENÉ: podložený konzistentný no-write snapshot živého WAL, retry a cancellation SQLite, kompletná funkčnosť OpenCode, runtime aplikácie, aktuálne PR a CI. OpenCode je zámerne nedostupný, nie dokončený.
- Ďalší krok: Nájsť a otestovať podporovaný snapshot alebo VFS bez zápisov do zdroja; pokračovať v terminálovom CLI a syntetickom lifecycle orchestrácie. V `<repo>` opätovne overiť `git status --short --branch`, sieť, úplné testy a presné SHA pred pushom feature vetvy.

## 2026-11-06 09:50 +01:00 (Europe/Bratislava) – Terminálový Usage príkaz
- Vetva `feat/usage-hardening`; predchádzajúci lokálny commit `1ceb136adbbfa12d79c4db82598ab305825e3c95` zavádza bezpečné odmietnutie OpenCode. Posledný známy tracking SHA `83d147d1096cad2e5ab3879d0df135c5badc466f`; GitHub a CI zostávajú nedostupné.
- Zmena: `pnpm.cmd usage <agent> <zdroj>` preloží aktuálny kód parsera do projektového ignorovaného build adresára a zobrazí súhrn v JSON bez jednotlivých relácií. Subsety cache/reasoning nie sú pripočítané druhýkrát, cena je označená ako neznáma, čiastočný výsledok je výslovný. Príkaz nepoužíva potenciálne starý zabalený sidecar.
- Kontroly: Syntetický komprimovaný Codex zdroj v CLI vrátil jeden záznam a očakávané počty; OpenCode syntetický zdroj bol označený partial s vysvetlením. Súprava `pnpm.cmd exec vitest run --configLoader runner` prešla 50/50 vrátane regresného CLI testu; ESLint a TypeScript prešli. Frontend Vite build v novom izolovanom build adresári prešiel, nejde však o Tauri runtime.
- NEOVERENÉ: Živý SQLite WAL, aktuálny zabalený sidecar, Tauri aplikácia, CI a reálna orchestrácia. Žiadne používateľské logy ani prihlasovacie údaje tu nie sú zapísané.
- Ďalší krok: Skontrolovať syntetický orchestration harness a jeho testy, potom pokračovať synchronizáciou Usage UI a overením bezpečných worker protokolov. Sieť GitHub a plné runtime overenie ostávajú potrebné pred odovzdaním.

## 2026-11-06 09:53 +01:00 (Europe/Bratislava) – Zlúčenie hardening do Usage UI
- Vetva `feat/usage-ui`; predchádzajúci UI commit `6aa95cfc72e091245fb7ddc29e6c5b11bfb14278`, zlúčený lokálny hardening commit `34ab71066f422f1e703ab84109c9f681fa480ac9`. Ide o riadny merge bez prepisovania histórie; stav servera a CI nie je dostupný.
- Zmena: Zachované oba vývojové smery aj všetky rozdielne záznamy denníka. Jediný merge konflikt bol v denníku, kde sa spojilo 10 UI a 16 hardening sekcií do 19 odlišných sekcií. Vopred existujúce nesledované dáta zostali nedotknuté.
- Kontroly: Po merge prešlo `pnpm.cmd exec vitest run --configLoader runner` 56/56; ESLint, koreňový TypeScript a samostatný TypeScript desktopu prešli. Sada sidecar testovala predchádzajúci staging, nie novozabalený kód.
- NEOVERENÉ: skutočný vzdialený stav oboch vetiev, ich CI, runtime Tauri/CSP, no-write SQLite snapshot a správnosť stránkovania pri súbežnej zmene zdroja.
- Ďalší krok: Opraviť bezpečné stránkovanie UI a preveriť prekrývajúce sa zdroje, potom samostatne zapísať fake-only orchestration harness a pokračovať v natívnych approval protokoloch.

## 2026-11-06 09:58 +01:00 (Europe/Bratislava) – Konzistentné stránky a formátovanie
- Vetva `feat/usage-ui`; predchádzajúci merge commit `9c6bfcb3a4445df5d2c2e42739ca1bbee5f0a285`. Vzdialený server a CI zostávajú NEOVERENÉ pre sieťový blok.
- Zmena: Protokol vytvára SHA-256 odtlačok normalizovaného celého výsledku po poliach; UI vyžaduje rovnaký odtlačok aj počet záznamov na každej stránke a pri zmene odmietne zmiešaný výpočet. UI tiež opravuje hranice slovenských skratiek a ošetruje CSV vzorce, riadiace znaky a oddeľovače.
- Kontroly: `pnpm.cmd exec vitest run --configLoader runner` prešlo 62/62 vrátane zmeny zdroja medzi stránkami, formátovacích hraníc a CSV; cielený protokol/UI test 10/10, ESLint, koreňový a desktopový TypeScript prešli. Sidecar integračný test stále používa starší staging.
- NEOVERENÉ: reálny Tauri runtime, CSP, aktualizovaný zabalený sidecar, CI a prekrývanie už schválených zdrojov. UI vyžaduje nový sidecar so snapshotom; starší odmietne s pokynom na zostavenie. Čítanie OpenCode zostáva zámerne vypnuté.
- Ďalší krok: Bezpečne riešiť prekrývajúce sa zdroje bez poškodenia existujúceho zoznamu, uložiť fake-only orchestration a overiť natívne protokoly. Po obnovení prístupu overiť serverové vetvy, spustiť testy a pushnúť len feature vetvy.

## 2026-11-06 10:01 +01:00 (Europe/Bratislava) – Syntetický lifecycle
- Vetva `feat/orchestrator-foundation` závisí od lokálnej `feat/usage-ui`; predchádzajúci commit `eb0e1af44d026c2d5fa96453f603a3aff3b858df`. Vetva zatiaľ nie je odoslaná; GitHub a CI zostávajú pre sieťový blok NEOVERENÉ.
- Zmena: Pridaný výhradne fake-only stavový model, terminálové príkazy, lokálne syntetické ukladanie a CI príkaz testov. Scenár simuluje pridelenie, review, jednu opravu, jednorazové schválenie/odmietnutie, limit, timeout, STOP a obnovu. Spustenie bez `--fake` je odmietnuté. Rozhodovací dokument vysvetľuje neoverený upstream a hranice aktuálnej implementácie.
- Kontroly: `pnpm.cmd test:orchestrator` 7/7 a ESLint fake modulu prešli; `pnpm.cmd orchestrator:fake --help` jasne uvádza iba simuláciu. Lokálne generované Codex 0.166.0 schémy potvrdili typy approval správ, nie ich úplné vynútenie; Grok 1.0.70 help uvádza stdio, nie presný approval handshake.
- NEOVERENÉ / NEDOKONČENÉ: žiadni skutoční CLI worker ani manager, worktrees, reálny diff/review, Job Object STOP, skutočné approvals, tokeny/cena a vynútenie hraníc. Nebol importovaný upstream kód; presný commit, licencie závislostí, NOTICE a headless kompatibilita kandidáta sú neoverené. Syntetický test nie je dôkazom bezpečnosti živého režimu.
- Ďalší krok: Overiť bezpečné natívne procesové ukončenie a approval handshake, dokončiť OpenCode snapshot aj neprekrývanie Usage zdrojov. Po obnovení GitHubu overiť serverové SHA, odoslať závislé feature vetvy a CI pre konkrétne commity; žiadny push do main.

## 2026-11-06 10:05 +01:00 (Europe/Bratislava) – Dokumentácia a frontend build
- Vetva `feat/orchestrator-foundation`, predchádzajúci lokálny commit `5327447939599d2b4b1ca467724327950ac3191c`. Vzdialená vetva ešte nebola vytvorená; GitHub a CI zostávajú NEOVERENÉ.
- Zmena: Opravený starší opis OpenCode v `docs/log-formats.md`: aktuálna implementácia všetky jeho SQLite skeny označí partial a neotvára ich. Dokumentácia už nesľubuje čítanie WAL ani neoverenú cenu.
- Kontroly: `pnpm.cmd --filter wraith exec vite build --configLoader runner --outDir ../../.lab-m4/vite-build-ui-20261106-1005 --emptyOutDir false` úspešne zostavil frontend do nového adresára, bez zásahu do existujúceho `dist`; `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` prešiel. Toto nie je Tauri build ani manuálna skúška.
- Rozhodnutie / NEOVERENÉ: Samotné kanonické cesty nezachytia hardlinky medzi zdrojmi a ostáva pretek medzi kontrolou a otvorením súborov. Preto nemožno tvrdiť, že prekrývajúce sa zdroje sú bezpečne deduplikované. Natívny procesový experiment prebieha samostatne, bez reálnych workerov.
- Ďalší krok: Dokončiť a skontrolovať dôkaz Windows STOP, navrhnúť identitu otvorených zdrojových súborov a zachovať možnosť opravy starých konfliktných zdrojov; následne po obnovení siete overiť vetvy, testy, push a CI.

## 2026-11-06 10:08 +01:00 (Europe/Bratislava) – Syntetický Windows Job Object
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `09eb8eaa471bc0a75fd5b5ccc0dcaaa1f79a1b23`. Vetva nie je odoslaná, vzdialený stav a CI sú NEOVERENÉ.
- Zmena: Samostatný experiment vytvorí vlastný syntetický proces pozastavený, priradí ho do Job Object s kill-on-close a až potom ho obnoví. Po spustení syntetického potomka test zavrie job a overí ukončenie oboch procesov; nezávislý syntetický proces musí zostať živý a potom sa prirodzene ukončí. Pridaný je aj CI krok pre Windows.
- Kontroly: `rustc --edition 2021 packages/orchestrator-core/native/job_stop.rs -o <nový-testovací-výstup>`, následný `--self-test` a `rustfmt --edition 2021 --check packages/orchestrator-core/native/job_stop.rs` prešli na natívnom Windows x64. Procesy boli syntetické; žiadny skutočný Codex ani Grok nebol spustený.
- NEOVERENÉ / NEDOKONČENÉ: napojenie na supervisor, správanie skutočných CLI/launcherov, STOP počas reálneho approval, obnova, sandbox a schvaľovanie chránených operácií. Job Object je mechanizmus životného cyklu, nie OS sandbox. CI pre tento commit zatiaľ neexistuje alebo nie je dostupné.
- Ďalší krok: Dôkaz zapojiť do riadeného supervisora až po overení protokolov a hraníc, opraviť prekrývajúce sa Usage zdroje a OpenCode snapshot, sprístupniť GitHub a po kontrole vzdialeného stavu poslať závislé feature vetvy.

## 2026-11-06 10:10 +01:00 (Europe/Bratislava) – Overenie aktuálneho stdio
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `0dfef18ee9dcd0acf5219e5ff976308b956595b3`. Vetva nemá overený vzdialený náprotivok; GitHub a CI zostávajú nedostupné.
- Kontroly: Aktuálnu `apps/usage-service/src/main.ts` som preložil do nového ignorovaného testovacieho adresára a spustil cez stdio na syntetickom zstd zdroji. Dve stránky mali očakávané počty a rovnaký snapshot ID. Existujúci staging som neprepísal; nejde o test zabaleného sidecaru ani Tauri bridge. Predchádzajúca úplná sada mala 62/62, fake lifecycle 7/7 a natívny syntetický Job Object test prešiel.
- NEOVERENÉ / NEDOKONČENÉ: balený aktuálny sidecar a desktop runtime; OpenCode snapshot; deduplikácia prekrývajúcich sa zdrojov; živý Codex manažér a Grok worker, ich approval a reálny STOP; licencie a pripnutý upstream; vzdialené SHA, PR a CI.
- Pokračovanie: Vetvy sú závislé v poradí `feat/usage-hardening` → `feat/usage-ui` → `feat/orchestrator-foundation`. Posledné lokálne známe tracking SHA: hardening `83d147d1096cad2e5ab3879d0df135c5badc466f`, UI `6aa95cfc72e091245fb7ddc29e6c5b11bfb14278`; skutočný server sa nepodarilo overiť. Po obnovení prístupov v `<repo>` vykonať `git status --short --branch`, `git fetch origin`, `pnpm.cmd exec vitest run --configLoader runner`, `pnpm.cmd test:orchestrator`, `pnpm.cmd exec eslint packages/usage-core/src packages/usage-core/tests`, `pnpm.cmd exec tsc --noEmit` a `pnpm.cmd --filter wraith exec tsc --noEmit`. Overiť presné lokálne a serverové SHA, potom odoslať iba feature vetvy a skontrolovať CI pre každé odoslané SHA. `main` nezlučovať.

## 2026-11-06 10:16 +01:00 (Europe/Bratislava) – Pokus o odoslanie
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `f0390326ae98779c96d28f568440dfbf45050308`. Lokálne vrcholy v čase pokusu: hardening `34ab71066f422f1e703ab84109c9f681fa480ac9`, UI `eb0e1af44d026c2d5fa96453f603a3aff3b858df`.
- Kontrola: `git push origin refs/heads/feat/usage-hardening:refs/heads/feat/usage-hardening` zlyhal pri spojení s `github.com:443`. Nebol použitý force push ani zmena `main`; ďalšie vetvy sa pre tú istú sieťovú chybu neposielali. Predchádzajúce výsledky testov sú uvedené vyššie, nové testy sa pri tomto pokuse nespúšťali.
- NEOVERENÉ: aktuálne vzdialené SHA, PR a CI. Posledné lokálne známe tracking SHA zostávajú hardening `83d147d1096cad2e5ab3879d0df135c5badc466f` a UI `6aa95cfc72e091245fb7ddc29e6c5b11bfb14278`; nemožno ich vydávať za aktuálne údaje zo servera.
- Ďalší krok: Obnoviť povolené sieťové spojenie, vykonať `git fetch origin`, porovnať vzdialené a lokálne vetvy a štandardne odoslať feature vetvy v poradí závislostí. Potom overiť vzdialené SHA a CI; zostávajúce funkčné a bezpečnostné úlohy sú uvedené v predchádzajúcom zápise.

## 2026-11-06 10:34 +01:00 (Europe/Bratislava) – Overenie prístupu a testov
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `3260ee9921ad7aac17f413115b963ae40f44909c`. Posledné známe tracking SHA sú v predchádzajúcom zápise; skutočný vzdialený stav a CI sú NEOVERENÉ.
- Kontroly: `git ls-remote origin HEAD` v sandboxe zlyhal pri spojení. Požiadavku na schválenie toho istého čítacieho príkazu mimo sandboxu mechanizmus odmietol, pretože politika relácie neumožňuje schválenie sandboxovej výnimky. Používateľ uviedol, že príkaz v jeho bežnom PowerShelli funguje. `pnpm.cmd exec vitest run --configLoader runner` prešlo 62/62, `pnpm.cmd test:orchestrator` 7/7 a koreňový aj desktopový TypeScript prešli.
- Problémy / NEOVERENÉ: Sidecar test používa predtým zabalený staging; živá orchestrácia, Tauri runtime, SQLite snapshot a CI zostávajú nedokončené alebo neoverené. Nesledované `agent-usage/` a generované Tauri permissions zostali zachované.
- Ďalší krok: Používateľ môže vo svojom PowerShelli po `git fetch origin` štandardne odoslať vetvy `feat/usage-hardening`, `feat/usage-ui` a `feat/orchestrator-foundation`, potom porovnať vzdialené SHA a skontrolovať CI. Nepoužiť force ani push do main.

## 2026-11-06 10:54 +01:00 (Europe/Bratislava) – Účtovanie oznámení Codexu
- Vetva `feat/orchestrator-foundation`; predchádzajúci commit `e5383c1ea022fdf82ee53d3a3698b07fc815337d`, ktorého odoslanie potvrdil používateľ. PR a CI cez `gh` zostávajú NEOVERENÉ, keďže spojenie na GitHub API je v sandboxe zamietnuté.
- Zmena: Pridaný samostatný modul pre kumulatívne `thread/tokenUsage/updated` podľa lokálne vygenerovanej schémy Codex 0.166.0. Opakované snapshoty nesčítava viackrát, odmieta klesajúce či neplatné súčty a pri neznámej cene nedáva povolenie na plánovanie. Stav označuje subscription fakturáciu ako neznámu.
- Kontroly: `pnpm.cmd test:orchestrator` 9/9, ESLint orchestration modulu a `git diff --check` prešli. Testy spotreby používajú syntetické oznámenia; modul nie je pripojený k živému procesu.
- NEOVERENÉ / NEDOKONČENÉ: živý Codex manager a Grok worker, platné approval hranice, skutočné náklady a ich vynútenie, upstream commit/licencie/adaptéry, CI a reálny end-to-end test. `gh pr view` aj jediný štandardný pokus o čítanie upstreamu zlyhali pre sieťový blok; žiadny upstream kód nebol importovaný.
- Ďalší krok: Dokončiť a nezávisle otestovať Windows supervisor, overiť živé protokoly a zdrojový upstream cez povolenú sieť; až potom spustiť bezpečný schválený end-to-end test. Po obnovení siete odoslať lokálny commit feature vetvy bez force a skontrolovať presné SHA/CI.

## 2026-11-06 10:57 +01:00 (Europe/Bratislava) – Windows procesový supervisor
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `4f21ac22a7550aa875323b39bc568083214b0cba`, naposledy používateľom potvrdené odoslané SHA `e5383c1ea022fdf82ee53d3a3698b07fc815337d`. Vzdialené CI je NEOVERENÉ.
- Zmena: Pridaný interný primitív pre vytvorenie pozastaveného procesu, priradenie do vlastného Job Object pred obnovením a ohraničené ukončenie jeho procesov. Pridaný syntetický test argumentov a potomkov a Windows CI krok.
- Kontroly: Nezávisle spustené `rustc --edition 2021 packages/orchestrator-core/native/supervisor_test.rs -o <nový-testovací-výstup>`, testovací executable a `rustfmt --check` prešli na Windows. Vlastný worker a jeho potomok skončili, nezávislý syntetický proces prežil a prirodzene skončil.
- NEOVERENÉ / NEDOKONČENÉ: Primitív nie je pripojený k živému agentovi, nemá stdio, filtráciu prostredia ani vynútenie workspace/network/approval. Dedí prostredie rodiča, preto sa živý worker nesmie zapnúť. Grok approval handshake, upstream licencie/verzia a reálny end-to-end zostávajú nedokázané; sandboxová sieť blokuje GitHub.
- Ďalší krok: Získať upstream zdroje a protokoly cez povolený prístup, dokončiť izoláciu a approval handshake, potom vykonať živé testy a potvrdiť presný push a CI. Pri manuálnom pushi poslať iba `feat/orchestrator-foundation` bez force.

## 2026-11-06 13:18 +01:00 (Europe/Bratislava) – Audit odovzdaného základu
- Vetva `feat/orchestrator-foundation`; auditovaný HEAD `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`, zhodný s používateľom potvrdeným posledným pushom a lokálnym remote-tracking odkazom. GitHub API a aktuálne CI sú pre zákaz sieťového spojenia NEOVERENÉ.
- Rozsah: Diff oproti lokálne dostupnému `origin/main` obsahuje 53 súborov; Usage a UI sú zdedené z predchádzajúcich vetiev, orchestration obsahuje iba fake lifecycle, nenapojený token ledger a samostatné Windows procesové testy. Upstream kód nebol importovaný; licencie a adaptéry kandidáta sú NEOVERENÉ.
- Kontroly: `pnpm.cmd test` exit 1 (esbuild: prístup zamietnutý); `pnpm.cmd exec vitest run --configLoader runner` exit 0, 62/62; `pnpm.cmd test:orchestrator` exit 0, 9/9 syntetických testov; `pnpm.cmd lint`, samostatné kontroly TypeScriptu a `cargo fmt --check` exit 0. Vite build do nového izolovaného adresára a samostatný Windows Job Object test exit 0. Čistý auditný worktree: offline frozen pnpm install exit 0; balenie sidecaru a štandardný frontend build exit 1 na prístupe esbuildu; Rust clippy exit 1 pre chýbajúci generovaný manifest po neúspešnom balení. `cargo test` bol na žiadosť používateľa prerušený, výsledok nie je PASS.
- Nálezy: živý Codex/Grok manager/worker a bezpečné approvals chýbajú; OpenCode SQLite sken je vypnutý; prekrývajúce zdroje môžu zdvojiť súčty; aktuálny lokálny staging sidecaru nemá snapshotId, ktoré UI vyžaduje, hoci existujúci sidecar test prejde. Ledger prijíma nekonzistentné syntetické celkové tokeny, no momentálne nepovoľuje plánovanie. Načítanie webových fontov môže blokovať CSP; runtime NEOVERENÉ.
- Bezpečnosť dát: Nesledovaný `agent-usage/` je samostatný vnorený repozitár; permissions sú generované a nesledované. Počas auditu sa objavili nové používateľské zmeny ikon a nesledovaný záložný priečinok/log; všetko zostalo zachované. Auditný worktree zostal v `.lab-m4`, bez mazania.
- NEOVERENÉ: úplný čistý Tauri build, spustenie aplikácie/PowerShell/About/CSP, živý end-to-end a CI. Opravy kódu sa v tomto auditnom kroku nerobili. Ďalší krok: preskúmať uvedené nálezy, obnoviť povolený prístup na GitHub, dokončiť bezpečné adaptéry a samostatne testovať živý workflow; merge nenavrhovať ako hotový orchestrátor.

## 2026-11-06 14:20 +01:00 (Europe/Bratislava) – Oprávnenia terminálu a zatvárania
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `6926fb070a897cc6c5960d0277d81364d5af59ee`, posledný používateľom potvrdený vzdialený commit `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`; GitHub a CI NEOVERENÉ.
- Zistenie a zmena: Tauri po zavedení aplikačného ACL vyžaduje explicitné oprávnenia vlastných príkazov. Capability povoľovala Usage, ale nie terminálové a session/settings príkazy. Lokálna implementácia `onCloseRequested` po návrate handlera volá `destroy`, ktoré capability tiež nepovoľovala. Pridané sú iba konkrétne chýbajúce povolenia; CSP ani sandbox neboli vypnuté.
- Kontroly: Nový regresný test pred opravou oddelene zlyhal na chýbajúcom `allow-destroy` aj `allow-spawn-powershell`, po oprave 2/2 prešiel. `pnpm.cmd exec vitest run --configLoader runner` 64/64, desktopový TypeScript a ESLint prešli. Sidecarový test stále používa starší staging a nepreukazuje aktuálny zabalený protokol.
- NEOVERENÉ: Skutočné otvorenie nových relácií, `Get-Date`, prepínanie, individuálne ukončenie, zavretie okna a obnova po reštarte; na obrazovke nebolo nájdené otvorené okno Lab-M4. Používateľ bol požiadaný o manuálne overenie. Až jeho výsledok alebo vlastné viditeľné testovanie môže potvrdiť opravu runtime.
- Ďalší krok: Overiť používateľský test a prípadné chyby, potom opraviť zostávajúce auditné nálezy. Ikony, zálohy, logy, vnorený repozitár a nesledované permissions ponechať nedotknuté; odosielať len feature vetvu po overení siete.

## 2026-11-06 14:23 +01:00 (Europe/Bratislava) – Konzistencia tokenového ledgeru
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `eff9964ec697d697579a821a874ee8eee4769124`, posledný používateľom potvrdený vzdialený commit `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`. GitHub a CI NEOVERENÉ.
- Zmena: Ledger odmieta záporné, pretečené a nekonzistentné súčty; vyžaduje celok input + output a cache/reasoning ako podmnožiny podľa zaznamenaných pozorovaní Codexu. Rovnakú kontrolu vykoná aj pri obnovenom stave. Neplatné oznámenie nesmie zmeniť uložené počty; plánovanie zostáva fail-closed.
- Kontroly: Nový syntetický regresný test pre `inputTokens=999999,totalTokens=0` a ďalšie nezhody pred opravou zlyhal, po oprave `pnpm.cmd test:orchestrator` prešlo 10/10; ESLint orchestration a `git diff --check` prešli.
- NEOVERENÉ: Živý tokenový stream, cena/fakturácia a vynútenie rozpočtu; ledger nie je napojený na skutočného workera. Test terminálu a zatvárania vo viditeľnej aplikácii čaká na výsledok používateľa.
- Ďalší krok: Overiť manuálny test terminálu, potom pokračovať zvyšnými auditnými opravami bez zásahu do ikon a nesledovaných dát; poslať iba feature vetvu po sprístupnení siete.

## 2026-11-06 14:26 +01:00 (Europe/Bratislava) – Kontrola zabaleného protokolu
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `d0ab76c345d5aaa8f2816819bc692037e4b79953`, posledné používateľom potvrdené vzdialené SHA `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`. GitHub a CI NEOVERENÉ.
- Zmena: Integračný test existujúceho zabaleného sidecaru teraz vyžaduje platné `snapshotId` a jeho zhodu medzi stránkami, takže starší staging bez protokolu už nemôže prejsť týmto testom. Konfigurácia Tauri už pred dev/build spúšťa opätovné zabalenie.
- Kontroly: Aktuálny lokálny staging, ktorý sa od predošlého auditu zmenil, pri syntetickej požiadavke vracia snapshot; `pnpm.cmd exec vitest run --configLoader runner packages/usage-core/tests/sidecar.test.ts` prešlo 1/1. Staging som neprepisoval. Vykonanie kompletného balenia v sandboxe a čistý Tauri runtime zostávajú NEOVERENÉ.
- Ďalší krok: Vyčkať na manuálne overenie novej relácie, `Get-Date`, prepínania a zatvorenia okna; pokračovať v auditných opravách a overiť balenie na povolenom prostredí. Ikony a existujúce nesledované súbory ponechať nedotknuté.

## 2026-11-06 14:31 +01:00 (Europe/Bratislava) – Rust kontroly izolovanej capability
- Vetva `feat/orchestrator-foundation`, predchádzajúci lokálny commit `e5c79cd53d174ee7c19fc6bfe06682412fe34713`; posledný používateľom potvrdený vzdialený commit `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`. CI a aktuálny server sú NEOVERENÉ.
- Kontroly: Do vlastného existujúceho auditného worktree založeného na `ed5eb82` som skopíroval iba aktuálnu capability a kópiu už zabaleného sidecaru. `cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml` prešiel 6/6 a `cargo clippy --offline --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` prešiel. Oba príkazy skončili s exit 0; v hlavnom checkoute negenerovali permissions ani neprepisovali sidecar.
- NEOVERENÉ: Toto nie je čisté balenie sidecaru zo zdrojov ani Tauri GUI smoke. Skutočná nová relácia, `Get-Date`, prepínanie, zatvorenie a obnova okna stále čakajú na manuálny výsledok. Nové ikony a existujúce nesledované súbory zostali nedotknuté.
- Ďalší krok: Vyhodnotiť používateľský test; ak prejde, pokračovať auditnými opravami a podľa povoleného sieťového prístupu odovzdať feature vetvu. Ak neprejde, zaznamenať presnú runtime chybu a opraviť jej príčinu.

## 2026-11-06 14:38 +01:00 (Europe/Bratislava) – Izolovaný pokus o GUI smoke
- Vetva `feat/orchestrator-foundation`, predchádzajúci lokálny commit `fad0a5e0c8fb0f098c0e24b3ba29a8d6f8dfc964`; posledný používateľom potvrdený vzdialený commit `ed5eb82460b35dd4a58edc2b3c7dcebf62a1d79c`, aktuálny GitHub a CI NEOVERENÉ.
- Kontroly: V auditnom worktree s aktuálnou capability a kópiou sidecaru `pnpm.cmd --filter wraith exec vite build --configLoader runner --emptyOutDir false` a `cargo build --offline --manifest-path apps/desktop/src-tauri/Cargo.toml` prešli. Vite preview na porte 1430 a debug proces aplikácie s novým izolovaným profilom sa spustili, ale Computer Use nezobrazil okno Lab-M4. Obe vlastné procesové relácie boli ukončené; kontrola nenašla bežiaci testovací proces ani listener.
- Problémy: Bežný Vite dev server v auditnom sandboxe skončil pri esbuild optimalizácii s `Access is denied`; preview nemení toto zistenie. Žiadne systémové nastavenia, ikony, pôvodný staging ani cudzie procesy sa nemenili.
- NEOVERENÉ: Viditeľný štart, nová relácia PowerShell, `Get-Date`, prepínanie a zatvorenie okna. Bez výsledku manuálneho testu nemožno tvrdiť, že oprava funguje. Neoverené sú aj živý orchestrátor, CI a aktuálny vzdialený SHA.
- Ďalší krok: Používateľ v bežnom PowerShelli spustí `pnpm.cmd tauri dev` v `<repo>` a overí novú reláciu, `Get-Date`, dve relácie, zavretie a opätovné otvorenie; podľa výsledku pokračovať opravou. Až následne dokončiť zvyšné priority a poslať feature vetvu bez force.

## 2026-11-06 14:49 +01:00 (Europe/Bratislava) – Izolované PowerShell a PTY testy
- Vetva `feat/orchestrator-foundation`; predchádzajúci commit `332e2c75d1996f6468daa32d6a20907701d7c133`, ktorého odoslanie potvrdil používateľ. Aktuálne CI je NEOVERENÉ.
- Kontroly: Cielené capability testy prešli 2/2. Priamy `powershell.exe -NoLogo -NoProfile -NonInteractive` s `Get-Date` skončil exit 0 a vrátil syntetický marker. V auditnom worktree dva syntetické PowerShell PTY nevrátili marker do 15 sekúnd, ani jednorazový PowerShell príkaz a samostatný `cmd.exe` cez PTY do 10 sekúnd. Testy skončili exit 1; každé dieťa vytvorené testom bolo ukončené vlastným handle a nebol nájdený bežiaci testovací proces.
- Problém / NEOVERENÉ: Výsledok nedokazuje, či je príčinou izolované prostredie alebo ConPTY; nepreukazuje správanie v používateľovom okne. Computer Use nenašiel otvorené okno Lab-M4. Neviem preto potvrdiť vytvorenie relácie, výstup `Get-Date` ani zatvorenie okna. Používateľovi bola položená jednoduchá otázka, čo vidí po otvorení aplikácie.
- Ďalší krok: Podľa používateľského pozorovania overiť opravený build v jeho bežnom interaktívnom Windows prostredí, zachovať existujúce ikony a cudzie procesy a opraviť prípadnú zistenú runtime chybu.
