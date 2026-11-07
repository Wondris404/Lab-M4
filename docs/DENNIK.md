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

## 2026-11-06 14:51 +01:00 (Europe/Bratislava) – Vek lokálneho buildu
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `181cdf3bc80aa3e3bcc57df81df94d46e6ebce6d`, používateľom potvrdený vzdialený commit `332e2c75d1996f6468daa32d6a20907701d7c133`; CI NEOVERENÉ.
- Kontroly: `pnpm.cmd exec vitest run --configLoader runner packages/usage-core/tests/desktop-permissions.test.ts` prešlo 2/2. Existujúci debug `wraith.exe` v hlavnom checkoute má čas 13:03 a capability s opravou čas 13:28; generovaný capability snapshot je ešte starší. Spustenie pôvodného súboru teda nemožno považovať za test nových oprávnení.
- NEOVERENÉ: Nový build vo viditeľnej používateľskej relácii, vytvorenie terminálu, `Get-Date` a zatvorenie okna. Izolovaný testovací build sa síce zostavil, ale Computer Use jeho okno nevidel; neobchádzali sa systémové hranice. Zelené ikony a nesledované súbory zostali zachované.
- Ďalší krok: Zostaviť aktuálny zdroj v používateľovom bežnom Windows prostredí a overiť viditeľné správanie, alebo sprístupniť toto okno povolenému nástroju. Neoznačovať terminal ani zatvorenie za opravené bez výsledku.

## 2026-11-06 14:53 +01:00 (Europe/Bratislava) – Generované oprávnenia buildu
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `9fa13643c65ffcadedda58960f8ec4e1deb8b859`, posledný používateľom potvrdený vzdialený commit `332e2c75d1996f6468daa32d6a20907701d7c133`; CI NEOVERENÉ.
- Kontrola: Generovaný `capabilities.json` v izolovanom auditnom worktree po úspešnom Rust builde obsahuje konkrétne `core:window:allow-destroy`, `allow-spawn-powershell` aj ďalšie terminálové a session oprávnenia. To potvrdzuje spracovanie opraveného súboru buildom, nie úspešné volania vo WebView.
- NEOVERENÉ: Nový build v používateľovom viditeľnom okne, nová relácia, `Get-Date`, prepínanie, zatvorenie a obnova. Pôvodný debug executable je starší než oprava. Žiadne ikony či nesledované súbory sa nemenili.
- Ďalší krok: V bežnom interaktívnom Windows prostredí spustiť nový build a overiť vyššie uvedené kroky; po výsledku pokračovať konkrétnou opravou alebo potvrdením. Auditné pracovné súbory nečistiť bez povolenia.

## 2026-11-06 14:58 +01:00 (Europe/Bratislava) – PowerShell ConPTY s odpoveďou terminálu
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `4d39c807f3576d3a3c9a3352efe38662f3db1b34`; posledný používateľom potvrdený vzdialený commit `332e2c75d1996f6468daa32d6a20907701d7c133`. CI a aktuálny server NEOVERENÉ.
- Zistenie: Predošlé izolované PTY testy z 14:49 neposkytovali odpoveď na štartovaciu ConPTY požiadavku na polohu kurzora. Po doplnení syntetickej terminálovej odpovede prešiel `cmd.exe` aj dve súbežné relácie PowerShell s `Get-Date`. Pôvodné timeouty preto nemožno považovať za dôkaz chyby PowerShellu ani aplikácie.
- Zmena a kontroly: Pridaný explicitne spúšťaný Windows regresný test `terminal_pty_smoke.rs`. V izolovanom worktree prešiel `cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --test terminal_pty_smoke -- --ignored --nocapture`: 1/1, exit 0; overil vstup a výstup `Get-Date` v dvoch PTY a prežitie druhej po skončení prvej. `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` a dva capability testy prešli. Test ukončuje iba procesy, ktoré vytvoril.
- NEOVERENÉ: Test nepreukazuje Tauri invoke, vykreslenie xterm, prepínanie kariet, zatvorenie okna ani obnovu; viditeľný GUI test stále chýba. Test je štandardne označený `ignored` a treba ho spustiť uvedeným príkazom, nesmie sa započítať ako automaticky vykonaný CI test.
- Ďalší krok: V používateľskej interaktívnej relácii overiť nový build, nové relácie a zatvorenie/obnovu okna; podľa výsledku riešiť prípadnú chybu. Ikony a existujúce nesledované súbory ponechať nedotknuté.

## 2026-11-06 15:01 +01:00 (Europe/Bratislava) – Odpoveď xterm na ConPTY
- Vetva `feat/orchestrator-foundation`; predchádzajúci lokálny commit `75f2ca411ffcd5ebb4d8b678be59c2876050455b`; posledný používateľom potvrdený vzdialený commit `332e2c75d1996f6468daa32d6a20907701d7c133`. CI NEOVERENÉ.
- Zmena: Pridaný regresný test skutočnej používanej knižnice xterm, ktorý overí odpoveď na ConPTY požiadavku polohy kurzora aj pred otvorením terminálu. Nejde o simuláciu odpovede v aplikácii, ale ani o úplný Tauri IPC test.
- Kontroly: Cielené testy xterm a capability `pnpm.cmd exec vitest run --configLoader runner packages/usage-core/tests/xterm-handshake.test.ts packages/usage-core/tests/desktop-permissions.test.ts` prešli 3/3; koreňový TypeScript a cielený ESLint prešli. Prvý TypeScript pokus zlyhal na nedostupnom typovom importe izolovaného desktop balíka, test bol upravený bez zmeny závislostí a opakovaná kontrola prešla.
- NEOVERENÉ: Tauri event/IPC prepojenie, viditeľná PowerShell relácia, prepínanie, zatvorenie a obnova okna. Computer Use okno nevidí; pôvodný debug executable je starší než oprava capability. Zelené ikony a nesledované súbory zostali nedotknuté.
- Ďalší krok: Spustiť aktuálny build vo viditeľnej používateľskej relácii a overiť celý tok; nepripisovať tento unit test ako dôkaz fungujúceho GUI.

## 2026-11-06 15:13 +01:00 (Europe/Bratislava) – Diagnostika zlyhaného CI
- Vetva `feat/orchestrator-foundation`, predchádzajúci a vzdialený commit `777224f7e232706245b5fec9f4ec797797dce19b`. CI https://github.com/Wondris404/Lab-M4/actions/runs/42231521508: Node prešiel, Windows test Job Object zlyhal; ďalšie Rust kontroly a build sa nespustili.
- Zlyhanie `job-stop-proof.exe --self-test` reprodukované lokálne; doplnená diagnostika počtu procesov a stavu workera. Lokálne test hlási tri procesy v jobe a bežiaci worker, exit 1; toto ešte nevysvetľuje príčinu na GitHub runneri. Prvý pokus o opätovné zostavenie na rovnaké meno zlyhal linkerom LNK1104, zostavenie pod novým názvom prešlo.
- NEOVERENÉ: príčina tretej položky a stav procesov na CI; test ani ochrany sa nevypínali. Ďalší krok: zistiť identitu členov jobu a prečo ich test zaznamenáva viac, až potom navrhnúť a overiť opravu. Zachovať používateľove súbory a neukončovať cudzie procesy.

## 2026-11-06 23:30 +01:00 (Europe/Bratislava) – Čiastočná kontrola otvorených PR
- Kontrolované vzdialené hlavy: #10 `34ab71066f422f1e703ab84109c9f681fa480ac9`, #9 `eb0e1af44d026c2d5fa96453f603a3aff3b858df`, #11 `d0e50a53b48deea44cfbad46faea738d7679890d`. Vetvy sú v poradí predkov #10 → #9 → #11; každé PR má základ main.
- Zistenie: opakovaný výber toho istého zdroja vytvorí dva identifikátory a UI výsledky sčíta. Syntetické volanie s dvoma zdrojmi a jedným záznamom po 10 vstupných tokenov vrátilo dva záznamy a súčet 20. Riešenie musí zachovať legitímne identické udalosti a zohľadniť prekrývajúce sa zdroje; zatiaľ nebolo implementované.
- Na #11 v čistom linuxovom worktree prešli `pnpm package:usage-sidecar`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (67 testov) a `pnpm test:orchestrator` (10 testov), všetky exit 0. Spúšťanie procesových testov v základnom sandboxe zlyhalo; opakovanie s povolenými lokálnymi socketmi prešlo. Rust toolchain nebol dostupný.
- NEOVERENÉ: kompletná revízia všetkých súborov a vetiev, oprava deduplikácie, natívne Windows GUI a PTY, nainštalovaný sidecar, živí agenti. OpenCode čítanie je zámerne vypnuté a kontrola integrity kurzora znovu číta celý prefix. Žiaden opravný commit ani push sa nevykonal.
- Ďalší krok: navrhnúť identitu záznamov a bezpečné spracovanie prekryvov, pridať regresné testy na #10 a závislosti šíriť bežnými merge commitmi; dokončiť celú revíziu a Windows overenie.
## 2026-11-06 23:38 +01:00 (Europe/Bratislava) – Identita zdrojov a vypnuté hooky
- Vetva `feat/usage-hardening`, kontrolovaný základ `34ab71066f422f1e703ab84109c9f681fa480ac9`. Opakovaný výber zdroja a prekryv priečinka so súborom mohli po pripojení UI násobiť súčty. Backend teraz určuje prekrytie podľa kanonických schválených ciest a poskytovateľa, vrátane pravidla priečinka `.codex`; neposiela cesty do UI. Pripojenie UI a jeho regresné testy patria do nadväzujúcej vetvy.
- Odstránené volanie neregistrovaného `ensure_agent_hooks`; automatická inštalácia zostáva vypnutá. Nový test kontroluje volanie aj registráciu. Pridaný test čerstvosti sidecaru porovnáva balík so zostavením aktuálneho zdroja; zastaraný ignorovaný artefakt nemá prejsť ako aktuálny.
- Overenie v Linuxe s pnpm 10.29.3: `pnpm package:usage-sidecar`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (52 testov) a `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` exit 0. Samostatný `rustc --test` pre rozhodovanie o prekrytí: 3 testy, exit 0. Plné Cargo kontroly vyžadujú systémové GTK/WebKit knižnice, ktoré tu chýbajú.
- NEOVERENÉ: natívne Windows GUI, PTY, nainštalovaný sidecar a reálna orchestrácia. Rôzne kópie alebo hardlinky nemožno spoľahlivo stotožniť iba podľa kanonickej cesty; bez potvrdenej identity udalosti ich táto zmena nezlučuje. Ďalší krok: doplniť spracovanie prekrytých zdrojov v #9, integračné testy a bežným merge commitom preniesť zmeny do #11.

## 2026-11-06 23:43 +01:00 (Europe/Bratislava) – Prekryv zdrojov v Usage UI
- Vetva `feat/usage-ui`; zlúčený základ opravy `5e6e6b5fa69311a7ed614b688bd23d89ba485067`. UI skenuje iba nepokryté schválené zdroje a pri prekryve zobrazí upozornenie; pri chýbajúcej alebo cyklickej informácii odmietne miešať údaje. Žiadne udalosti sa nezlučujú podľa tokenov ani zobrazovaného textu.
- Testy pokrývajú opakovaný zdroj, priečinok so súborom v opačnom poradí a dve samostatné udalosti s rovnakými zobrazenými hodnotami; integračný prípad používa skutočný syntetický Codex parser a cache. Po zostavení sidecaru prešli `pnpm lint`, `pnpm typecheck` a `pnpm test` (68 testov), exit 0, pnpm 10.29.3.
- NEOVERENÉ: Windows UI a inštalátor; rôzne kópie a hardlinky bez spoľahlivej identity sa nezlučujú. Ďalší krok: preniesť zvyšné opravy backendu, skontrolovať menu a preniesť reťazec do orchestrátora.
## 2026-11-06 23:42 +01:00 (Europe/Bratislava) – Identita relácie v Grok deduplikácii
- Pri syntetickom teste premapovanie rovnakého `sid` na druhú reláciu spôsobilo zahodenie jej udalosti, ak sa zhodovali čas, index a počty. Do existujúceho deduplikačného kľúča sa pridala aktuálne priradená relácia; opakovanie v tej istej relácii zostáva odfiltrované.
- Po zmene sa zneplatní starý kurzor pre Grok JSONL a verzia cache pre komprimovaný Grok zdroj. Cielené `pnpm exec vitest run packages/usage-core/tests/grok-session-dedupe.test.ts packages/usage-core/tests/grok-cursor.test.ts packages/usage-core/tests/parsers.test.ts packages/usage-core/tests/cache.test.ts`: 20/20, exit 0; `pnpm lint`: exit 0.
- NEOVERENÉ: Grok neposkytuje v skúmanom formáte potvrdený jednoznačný identifikátor každej inference udalosti. Existujúca deduplikácia podľa `sid`, relácie, indexu, času a počtov preto zostáva heuristikou a môže zlúčiť dve nerozlíšiteľné udalosti tej istej relácie. Živý Grok a Windows GUI neboli spustené.

## 2026-11-06 23:50 +01:00 (Europe/Bratislava) – Opravy syntetickej orchestrácie
- Opravené uloženie timeoutu pri plnom logu a kontrola rozporných prírastkov tokenových podmnožín pred zmenou ledgeru. Ide výhradne o syntetický režim; živé adaptéry a vynútiteľné approvals chýbajú.
- Po zostavení sidecaru prešli `pnpm lint`, `pnpm typecheck`, `pnpm test` (80 testov) a `pnpm test:orchestrator` (15 testov), exit 0. Windows GUI, PTY, nainštalovaná aplikácia a živá orchestrácia zostávajú NEOVERENÉ.
## 2026-11-06 23:46 +01:00 (Europe/Bratislava) – Príznak neznámej Grok relácie
- Dve syntetické Grok udalosti s rôznymi trace ID bez potvrdenej väzby na reláciu dostávali rovnaký `unknown` a UI ich mohlo započítať ako jednu skutočnú reláciu. Backend teraz vracia `sessionKnown: false` pre neprepojené udalosti a `true` pre známe relácie; z trace ID neodvodzuje identitu relácie. Nadväzujúce UI musí neznáme relácie vynechať zo známeho počtu a označiť neúplnosť.
- Zneplatnené staré JSONL kurzory aj komprimované cache bez príznaku. Cielené parserové, protokolové a kurzorové testy 23/23, `pnpm lint` a `pnpm exec tsc --noEmit`: exit 0. Nové testy pokrývajú opakované čítanie aj zneplatnenie oboch druhov cache.
- NEOVERENÉ: údaje skutočných Grok inštalácií, Windows GUI a živá orchestrácia. Ďalší krok: zapojiť príznak do UI a hashu snapshotu v závislých vetvách.

## 2026-11-06 23:48 +01:00 (Europe/Bratislava) – Súhrn používa príznak relácie
- Súhrn už nezamieňa potvrdenú reláciu s doslovným ID `unknown` s neprepojenou reláciou: počet a označenie neúplnosti vychádzajú z `sessionKnown`. Syntetický test preveruje najprv potvrdené ID a potom pridanie neprepojenej udalosti.
- Cielené testy parserov a súhrnov: 18/18, exit 0; `pnpm lint` a `pnpm exec tsc --noEmit`: exit 0. NEOVERENÉ: skutočné Grok dáta a zobrazenie v natívnej Windows aplikácii.

## 2026-11-07 00:03 +01:00 (Europe/Bratislava) – Ochrana checksumu a ďalšie opravy
- `fzstd` neoveruje checksum Zstandard; poškodený syntetický rámec predtým vrátil dáta bez varovania. Sken teraz takéto rámce bezpečne odmietne, označí výsledok partial a vysvetlí dôvod; invaliduje dotknutú cache. To dočasne vylučuje aj platné checksummed archívy. Ďalší krok je streamingové overenie každého rámca bez oslabenia limitov.
- Doplnené označenie neznámych Grok relácií, ochrana pred ich falošným sčítaním, hlásenie chyby vytvorenia terminálu a úzko vymedzené CSP pre existujúce Google fonty. Načítanie fontu posiela požiadavku poskytovateľovi, pozri README. Zablokovaný PTY zápis môže stále blokovať zatvorenie; bezpečná oprava poradia vstupu a Windows overenie zostávajú otvorené.
- Pred poslednou checksum zmenou prešli na Linuxe `pnpm package:usage-sidecar`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (61 testov) exit 0; cielené testy checksumu a parserov po zmene prešli 19/19. Windows GUI aj živí agenti NEOVERENÉ.

## 2026-11-07 00:23 +01:00 (Europe/Bratislava) – Overenie Zstandard checksumov
- Na základe `4488c96afaa2bd0de38535d7bbf516ae51da73e1` nahradené odmietanie checksummed rámcov skutočným streamovým XXH64 overením každého rámca. Použitá je knižnica `xxhash-wasm` 1.1.0 s licenciou MIT, ktorá sa prikladá k zabalenému sidecaru. Existujúci `fzstd` a limity okna, súboru a skenu zostávajú; checksum sa overuje nad rozbalenými bajtmi a porovnáva sa jeho dolných 32 bitov.
- Testy pokrývajú platný checksum, chybný checksum, rámec bez checksumu, hranicu čítacieho chunku, skippable a zreťazené rámce, neskoršiu korupciu, skrátenie a limity. Pri chybnom súbore sa jeho záznamy nezapočítajú; ostatné úplné súbory sa zachovajú a výsledok je partial. Zastarané cache verzie sa nepoužijú.
- Na Linuxe prešli `pnpm package:usage-sidecar`, `pnpm lint`, `pnpm typecheck` a celá sada `pnpm test` 96/96; cielené testy po dodatočnej kontrole bezpečných ciest 24/24. Node 20.20.2 prešiel 11 testov dekompresie. Použitý pnpm 10.29.3. Windows sidecar a GUI zatiaľ NEOVERENÉ.

## 2026-11-07 11:15 +01:00 (Europe/Bratislava) – Overený základ a diagnostika terminálu
- Izolovaný Git clone prešiel kontrolou `git fsck --full`. Serverový `main` je `4488c96afaa2bd0de38535d7bbf516ae51da73e1`; hlava otvoreného PR #12 je `eb329bec9de65ee826ecd3deb4020e0102af7cd0`, strom `9bf01bc7b6cc4c64fc63a83ab259e422cd4e8322`. Vetva `codex/terminal-lifecycle` vychádza z PR #12. Pôvodný checkout a vnorený repozitár zostali nedotknuté.
- Po `pnpm install --frozen-lockfile` s pnpm 10.29.3 prešli `package:usage-sidecar`, `lint`, `typecheck` s frontend buildom, `test` (98/98) a `test:orchestrator` (15/15 syntetických), všetky exit 0. Baseline používal commit `a913acc6a4621ed0248deb04a1a0cd088ee17291`, ktorý oproti #12 mení iba WebDriver harness a jeho CI.
- Draft PR #13 nadväzuje na #12. Diagnostický CI https://github.com/Wondris404/Lab-M4/actions/runs/42362559107 potvrdil timeout pri `POST /session` po úspešnej odpovedi drivera na `/status`. K načítaniu UI a testu relácie sa nedostal. Presná príčina neúspešného pripojenia zostáva otvorená.
- Zápis do PTY teraz vlastní jeden worker na reláciu s ohraničenou frontou a potvrdením výsledku. Renderer posiela vstupy jednej relácie postupne a explicitne hlási odmietnutie. Pri ukončení Windows worker zruší synchrónny zápis a čaká na koniec vlákna. Reader ďalej odčerpáva ConPTY výstup počas jeho zatvorenia. Rust `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` prešiel 10/10 vrátane blokovaného Windows pipe. Nový test fronty, typecheck a lint prešli.
- NEOVERENÉ: úplný lifecycle GUI, ukončenie celého stromu potomkov terminálového procesu a balený runtime. Izolovaný GUI build používa oddelený identifikátor aplikácie a testovací WebView2 profil.
- Natívny EdgeDriver 156.0.4314.58 sa lokálne zhodoval s WebView2. Verbose log potvrdil spustenie wraith.exe a WebView2 log načítanie frontendu, ale do timeoutu nevznikol DevToolsActivePort. Samotná nezhoda verzií preto lokálny timeout nevysvetľuje. CI runner používal Server 2025; https://github.com/actions/runner-images/issues/14738 popisuje rovnaký problém pripájania a úspech na Server 2022. Zmenený je iba runner WebDriver jobu. Výsledok nového behu je ešte NEOVERENÝ.
- Prvý Server 2022 beh https://github.com/Wondris404/Lab-M4/actions/runs/42363723211 vrátil chybu `session not created`: predinštalovaný EdgeDriver 156 a používaný WebView2 131.0.2903.86. GUI job preto číta verziu WebView2 z dokumentovaného registračného kľúča a pri nezhode získa kompatibilný driver od Microsoftu. Pôvodný timeout na Server 2025 má stále iba čiastočnú diagnózu.
- Windows terminál používa natívny ConPTY a `PROC_THREAD_ATTRIBUTE_JOB_LIST`. PowerShell je v súkromnom Job Object už pri vytvorení procesu. Cleanup ukončuje procesy relácie, zatiaľ čo reader odčerpáva výstup. Native regresia overila chybu spawnu a retry, príslušnosť potomka do jobu, jeho ukončenie a funkčný `Get-Date` v druhej relácii. Pred doplnením poslednej regresie súbežného close prešlo 11/11 Rust testov a Clippy. Lokálny MSVC linker pri opakovanom použití mena testovacieho exe dvakrát hlásil LNK1104; overenie konečného commitu pokračuje samostatným výstupom a CI.
- CI https://github.com/Wondris404/Lab-M4/actions/runs/42364177113 so zhodným WebView2 a EdgeDriver 131 prešiel pripojením, načítaním UI, bridge aj vytvorením prvej relácie. Screenshot pri chýbajúcom markeri zachytil zaplnenie pôvodnej frontendovej fronty pri dávke klávesov a neúplný príkaz PowerShellu. Renderer teraz spája čakajúce vstupy jednej relácie v poradí do IPC dávok najviac 256 KiB, s limitom 512 KiB a 4096 čakajúcich požiadaviek na reláciu. Syntetické regresie zahŕňajú 200 rýchlych klávesov, nezávislú reláciu, hranice dávok a explicitné odmietnutie pretečenia. Natívny Rust test s oddeleným debug výstupom prešiel 12/12 vrátane súbežného close. GUI na novej hlave ešte NEOVERENÉ.
- CI na `d2f28dd` https://github.com/Wondris404/Lab-M4/actions/runs/42364899189: Node PASS. GUI znovu dosiahlo prvú PowerShell reláciu. Screenshot ukazuje dva dokončené príkazy a celý tretí príkaz bez odmietnutých klávesov, ale test nepozoroval očakávaný súbor. Diagnostika teraz odlíši nesprávnu hodnotu od chýbajúceho súboru a pred zápisom vykreslí výsledok PowerShellu. Pri close počas výstupu test vyžaduje signál, že výstup začal, a overuje, že skončil skôr než sa dokončil.
- Kombinovaná natívna regresia vloží deterministicky blokovaný Windows pipe do skutočnej ConPTY relácie a spustí dve súbežné zatvorenia. Overí jedno prevzatie cleanupu, zrušený zápis a bezpečný opakovaný close. `cargo test --offline --locked --config 'profile.test.package.wraith.debug=0' --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` exit 0, 12/12. `cargo fmt --check`, `node --check scripts/windows-webdriver-smoke.mjs` a `git diff --check` exit 0.

## 2026-11-07 18:24 +01:00 (Europe/Bratislava) – Overený terminál a správnosť Usage
- PR #13 na hlave 40d326d prešiel všetkými tromi jobmi na testovacom merge commite 6a8c3cf: https://github.com/Wondris404/Lab-M4/actions/runs/42365454495. WebDriver overil dve nezávislé PowerShell relácie, poradie, Get-Date, zatvorenie relácie, zatvorenie okna v nečinnosti aj počas výstupu a opätovný štart.
- Na vetve `codex/usage-correctness` zachované lokálne commity `1dd6c1f`, `7fc8dbf` a `e83a0dc`. Grokove zmeny pridali označenie neistých súčtov, testy ConPTY a časovo ohraničené čakanie na ukončenie PowerShellu.
- Grok zachová riadky bez doloženej identity udalosti. Rovnaký fingerprint znamená možné opakovanie, chybný riadok možný podpočet. Súbeh oboch stavov sa prenáša do kurzora, protokolu a súhrnu. Codex označí vynechaný poškodený riadok ako čiastočný sken. Zmenené verzie kurzorov a cache zabránia opakovanému použitiu starých výsledkov.
- Legacy EUR zostáva null bez overeného FX zdroja. CSV prenáša USD, pôvod ceny a stav skenu. OpenCode je explicitne nedostupný, kým nie je overený snapshot bez zmeny zdroja alebo WAL/SHM.
- V jednom Windows Node behu prešli `package:usage-sidecar`, `lint`, `typecheck` s buildom, `test` 105/105 a `test:orchestrator` 15/15, všetky exit 0. Testy zahŕňajú integritu Zstandard, neúplné riadky, UTF-8 hranicu, zmenu prefixu, rotáciu, truncation a súbežný append. Cargo fmt a git diff --check exit 0. Balík spustený z čistej inštalácie a živá orchestrácia zostávajú NEOVERENÉ.
- Natívne Windows `cargo test --lib` prešlo 15/15 s oddeleným link výstupom `profile.test.package.wraith.debug="line-tables-only"`, exit 0. Zahŕňa Grokove regresie blokovaného skutočného ConPTY vstupu, timeoutu a zatvorenia počas výstupu.

## 2026-11-07 – Balenie sidecaru a Windows release
- Windows staging sa generuje zo zdrojov. Obsahuje Node 24.22.2 z oficiálneho archívu, metadáta runtime, licencie Node, fzstd, xxhash-wasm a SQLite a natívny modul SQLite. Manifest je viazaný na zostavenie desktopu. Test čerstvosti zachytí starší staging.
- Jeden lokálny Windows Node beh s pripnutou verziou prešiel: `pnpm package:usage-sidecar`, `pnpm lint`, `pnpm typecheck` vrátane frontend buildu, `pnpm test` 105/105 a `pnpm test:orchestrator` 15/15, všetko exit 0. Test zabaleného sidecaru spustil pribalený Node bez PATH a overil `snapshotId`, stránkovanie a čiastočný výsledok pri poškodenom vstupe. Samostatná kontrola s PATH iba na System32 vrátila jeden riadok, 10 vstupných a 4 výstupné tokeny a neznámu cenu.
- `pnpm tauri build --ci --bundles nsis` v izolovanej kópii, exit 0. Výsledok `Lab-M4_0.2.0_x64-setup.exe`, 30 767 306 bajtov, SHA-256 `925a9cac755a3a8208b0470420e8500dc76962616f5dd876b2eb2cd4aa470888`. Vygenerovaný NSIS manifest zahrnul očakávané zdroje.
- Samostatný job `windows-installed-usage` je pripravený spustiť presný NSIS artefakt z toho istého CI behu na čistom Windows runneri. Vyžaduje neprítomnosť vývojárskeho stagingu a kontroluje obsah balíka a Usage GUI nad syntetickými vstupmi s PATH obmedzenou na System32. Výsledok čistej inštalácie a GUI na tejto vetve zostáva NEOVERENÝ.

## 2026-11-07 – Windows transport pre procesy adaptérov
- OrchestratorInc/agent-orchestrator bol preskúmaný na `8bf36847091d0fe2767a199f95b8f6f48ccc35db`: Apache-2.0, bez `NOTICE` v danom strome, backend Go 1.27.1 s `acp-go-sdk` a internými adaptérmi. Windows ACP cleanup používa `taskkill /T /F` s fallbackom na ukončenie koreňového procesu. Lab-M4 potrebuje vlastný Job Object pri spawne aj nezávislé pravidlá approvals. Kód kandidáta sa neprevzal.
- Native supervisor teraz vytvorí proces priamo v privátnom kill-on-close Job Objecte, odovzdá iba tri explicitné štandardné streamy a použije výslovne zostavené prostredie. Syntetický Windows test potvrdil oddelený stdout a stderr, prenos Unicode hodnoty, odmietnutie duplicitnej premennej, chýbajúcu premennú rodiča, zrušenie blokovaného stdin zápisu, ukončenie vlastného potomka a prežitie procesu mimo jobu. `rustc --edition 2021 -D warnings` a beh testu exit 0.
- Ručný protokolový smoke s týmto supervisorom spustil skutočné CLI v nových prázdnych profiloch. Codex 0.166.0 odpovedal na `initialize` a `account/read` s `refreshToken: false`. Grok Build 1.0.77 odpovedal cez ACP v1, ponúkol iba `grok.com` a odmietol `session/new` s kódom `-32000`. Pri STOP sa počet aktívnych procesov v privátnych joboch znížil pri Codexe z 3 na 0 a pri Groku z 2 na 0. Bez loginu, obnovy tokenu, modelového turnu alebo prenosu kódu.
- Dokumentácia xAI uvádza aj `cached_token` a `xai.api_key` pri vhodnej autentifikácii. Tento smoke overuje transport a lifecycle konkrétnych bináriek v prázdnom profile. Pre živý režim zostáva otvorená existujúca autorizovaná autentifikácia, vynútenie oprávnení na Windows, hranice I/O, skutočný diff a review. Job Object spravuje lifecycle. Fake CLI zostáva oddelené.

## 2026-11-07 20:10 +01:00 (Europe/Bratislava) – Transport s ohraničenou frontou
- Pracovný strom `C:\Users\ondre\Desktop\Lab-M4\.lab-m4\implementation-verified`, vetva `codex/orchestrator-transport`, commit `d29eb12c01bcaf6bdc21c53569f7a00050055f39`. Pôvodný checkout `C:\Users\ondre\Desktop\Lab-M4` ostal na `d0e50a5` s nesledovaným `agent-usage/`. Push sa nerobil. Zamietnutá publikácia Usage sa neopakovala. PR #13 ostáva na staršej hlave `40d326d`.
- Natívny transport rozlišuje zatvorenie vstupu (exit 0), zatvorenie výstupu agenta (2), chybu vstupu (3), plnú frontu (4) a timeout (124). Po timeoute aj po plnej fronte vypíše `LAB_M4_JOB_STOP` a skončí vlastný job na nulu. Test `windows-agent-transport.mjs` prešiel dvakrát, exit 0. Nezávislý proces mimo jobu prežil. `node --test` orchestrátora 18/18, exit 0. `cli.mjs start` bez `--fake` exit 1. Dva behy s `--fake` exit 0 a režim ostáva `fake`.
- Prázdny profil Grok Build skončil exit 1, hláška Not signed in. Prázdny profil Codex CLI exit 1 a nedokončil úlohu, diff ani review. Živý cyklus je BLOCKED. Tokeny sa nekopírovali.
- `pnpm package:usage-sidecar` v tomto shelli exit 1: Node v24.22.1 nemá vedľa seba LICENSE. Existujúci staging uvádza Node v24.22.2, preto freshness test neprešiel (110/111, jeden fail). Staging sa nemazal. Nový NSIS z tohto commitu sa nestaval. GUI sa v tejto session nespúšťalo. Oboje je NEOVERENÉ pre `d29eb12`.
- Report: `.lab-m4/reports/stav-2026-11-07-2010.md`.

## 2026-11-07 20:20 +01:00 (Europe/Bratislava) – Sidecar Node 24.22.2 a NSIS
- Na `84a9e4f5f1460b1f6e13eb660b7ccbbd2f3069aa` som zabalil sidecar oficiálnym Node v24.22.2, ktorý má vedľa seba LICENSE. `package:usage-sidecar` exit 0. Freshness test tým istým Node exit 0.
- S tým istým Node na PATH: `pnpm lint` exit 0, `pnpm test` exit 0 (33 súborov, 111 testov), `pnpm test:orchestrator` exit 0 (18/18), `pnpm typecheck` exit 0, `cargo fmt --check` exit 0, `cargo clippy -- -D warnings` exit 0, `cargo test --offline --locked` exit 0 (lib 15/15), ignorovaný `terminal_pty_smoke` exit 0 (1/1).
- `pnpm --filter wraith exec tauri build --ci --bundles nsis` exit 0. Inštalátor `apps/desktop/src-tauri/target/release/bundle/nsis/Lab-M4_0.2.0_x64-setup.exe`, 30 780 068 bajtov, SHA-256 `AE618BA4E48FBF7BF4A602BAE3E3B2CF42131F70A0E8BFFB6CEA50CEC7104645`, zo stromu `84a9e4f`. Nie je to starý balík z `5e0eee4`.
- `windows-installed-usage-smoke.ps1` exit 1: vyžaduje disposable GitHub-hosted runner a pred inštaláciou skončil. Používateľova aplikácia sa neinštalovala. Čistá inštalácia a GUI na `84a9e4f` ostávajú NEOVERENÉ.
- Živý Codex → Grok Build cyklus ostáva BLOCKED. Iný model sa nenasadil. Push sa nerobil.
- Na `4e128295` som dvakrát spustil `node scripts/windows-webdriver-smoke.mjs` proti čerstvému debug `wraith.exe`, s `tauri-driver` 2.1.0 a EdgeDriver 156.0.4314.58. Oba behy exit 1: `POST /session` TimeoutError a `hyper::Error(IncompleteMessage)` ešte pred terminálom. GUI na tomto SHA je NEOVERENÉ. Čistá inštalácia ostáva NEOVERENÉ, lebo inštalačný smoke skončil pred inštaláciou požiadavkou na GitHub-hosted runner.

## 2026-11-07 21:05 +01:00 (Europe/Bratislava) – WebView2 prepínače a nový NSIS
- Commit `5bf789be909b42a57f489fea66b988da894dd57a` na `codex/orchestrator-transport`. Okno z `tauri.conf.json` sa vytvára v setup, lebo automatické okno vzniká skôr, než sa dajú nastaviť argumenty. Pri `TAURI_WEBVIEW_AUTOMATION=true` alebo `TAURI_AUTOMATION=true` ide celý zoznam `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` cez API, doplnený o `--remote-debugging-port`, ak v ňom nie je číselný port, a o pôvodné `msWebOOUI` features v jednom `--disable-features`. Bežný štart premennú nevidí a port neotvára. Overené: proces žil, `debugPort=False`.
- `cargo test --offline --locked --lib` exit 0, 17/17. `cargo fmt --check` exit 0.
- Verbose msedgedriver 156.0.4314.58 nastaví `--enable-automation` a `--remote-debugging-port=0`. Príkazový riadok `msedgewebview2.exe` pre `wraith.exe` tieto prepínače obsahoval a `user-data-dir` bol v `scoped_dir` drivera. `DevToolsActivePort` počas behu nevznikol. Shell mal Medium integrity. Zhoda EdgeDriver a WebView2 156.0.4314.58 teda nestačí.
- `node scripts/windows-webdriver-smoke.mjs` na tomto debug exe: RUN1 exit 1, RUN2 exit 1. Oba skončili na `POST /session` TimeoutError a `hyper::Error(IncompleteMessage)`. K terminálu sa nedostali. Po behu neostal `wraith.exe`, `tauri-driver.exe` ani `msedgedriver.exe`. GUI ostáva NEOVERENÉ.
- `pnpm --filter wraith exec tauri build --ci --bundles nsis` s Node v24.22.2 exit 0. Inštalátor `apps/desktop/src-tauri/target/release/bundle/nsis/Lab-M4_0.2.0_x64-setup.exe`, 30 761 348 bajtov, SHA-256 `C593422C822A7F60E290D6CF0617728FA0F81DAC21605C025E151C707838766C`, čas súboru 2026-11-07 21:01:04, strom `5bf789b`. Čistá inštalácia sa nespúšťala. Push nebol. PR #13 ostáva na `40d326d`. Živý Codex → Grok Build ostáva BLOCKED.
- Report: `.lab-m4/reports/stav-2026-11-07-2105.md`.

## 2026-11-07 21:06 +01:00 (Europe/Bratislava) – Regresia na 8a69230
- Strom `8a69230f673fa145750c4094ceaa77b7f88be107`. Kód aplikácie je `5bf789b`; tento commit je denník nad ním. Node v24.22.2.
- `pnpm lint` exit 0. `pnpm typecheck` exit 0, vrátane produkčného frontend buildu. `pnpm test` exit 0: 33 súborov, 111 testov. `pnpm test:orchestrator` exit 0: 18 pass, 0 fail.
- `cargo clippy --offline --locked -- -D warnings` exit 0, `Finished dev profile` za 6,80 s, bez warningu. Ignorovaný `cargo test --test terminal_pty_smoke -- --ignored` exit 0: 1 passed, 0 failed.
- `rustc --edition 2021 -D warnings` pre `agent_transport.rs` aj `supervisor_test.rs` exit 0. `node packages/orchestrator-core/tests/windows-agent-transport.mjs` exit 0: spawn failure, deadline, EOF, backpressure, surviving control.

## 2026-11-07 21:14 +01:00 (Europe/Bratislava) – Jeden meraný strom 4f59e4c
- Všetky príkazy nižšie bežali pri checkout `4f59e4c67883beb6e7b78072e1e235c2fac4baad`. Node v24.22.2.
- `pnpm package:usage-sidecar` exit 0. `pnpm lint` exit 0. `pnpm typecheck` exit 0. `pnpm test` exit 0: 33 súborov, 111 testov. `pnpm test:orchestrator` exit 0: 18 pass, 0 fail.
- `cargo fmt --check` exit 0. `cargo clippy --offline --locked -- -D warnings` exit 0. `cargo test --offline --locked` exit 0: lib 17 passed, 0 failed, ConPTY test v predvolenom behu 1 ignored. Samostatný `--test terminal_pty_smoke -- --ignored` exit 0: 1 passed.
- `rustc -D warnings` transport aj sleeper exit 0. `windows-agent-transport.mjs` exit 0.
- `pnpm --filter wraith exec tauri build --ci --bundles nsis` exit 0. Inštalátor `apps/desktop/src-tauri/target/release/bundle/nsis/Lab-M4_0.2.0_x64-setup.exe`, 30 764 250 bajtov, SHA-256 `39A1F44DAF424D05D7A985F10F326FF71DC9C5C3AE00D6CFEDD84F86A9896F29`, čas súboru 2026-11-07 21:13:24, strom `4f59e4c`.
- GUI a živý Codex → Grok Build nie sú PASS. Čistá inštalácia je NEOVERENÉ. Push nebol.
- Report: `.lab-m4/reports/stav-2026-11-07-2113.md`.

- Celý beh na `1eb061f` odhalil náhodný pád `grok-cursor` (104/105, exit 1): dočasná cesta mala suffix `KEYJLz`, ktorý blokuje zámerná kontrola citlivých názvov. Syntetické fixture používajú hexadecimálny UUID suffix. Kontrola zdrojových ciest v aplikácii zostala zachovaná.

## 2026-11-07 – Regresie z review Usage
- Review pôvodnej vetvy našlo sedem bodov. V nadväzujúcej vetve už boli overené kanonické prekrytia zdrojov a označenie USD. UI po chybe jednotlivého zdroja zachová úplné snímky zdravých zdrojov. Stránky z nedokončeného skenu zdroja vynechá. Zlyhanie všetkých zdrojov alebo neplatný protokol zablokuje export. Používateľ môže odobrať uložený odkaz na zdroj. Pri prepnutí kariet Usage ponechá prebiehajúci sken.
- Úspešne overený Zstandard archív prijme aj posledný JSON záznam bez LF. Živý plain JSONL ďalej čaká na oddeľovač. Sken priečinka Codex zachová zdravé súbory pri individuálnej chybe čítania. Nadlimitný riadok v živom Grok logu vráti stabilný prefix ako čiastočný výsledok bez posunu uloženého kurzora.
- Po zostavení čerstvého sidecaru prešlo 111/111 JavaScript testov a 15/15 natívnych Rust testov. Prešiel aj TypeScript, ESLint, produkčný frontend build, Rust fmt a kontrola diffu. Lokálny MSVC opakovane odmietol zápis do pôvodného výstupu testov. Testy prešli s oddeleným výstupom cez `profile.test.package.wraith.debug=0`. Interaktívny smoke nainštalovanej aplikácie zostáva NEOVERENÝ.
