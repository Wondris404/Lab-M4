# Lab-M4 1.0.0 — príprava vydania

## Základ a rozsah

- Základ: aktuálny `main` pri prevzatí, `3a2b8b08653f450a7dc7698ace45a87f3bf69bd2`.
- Desktop npm balík, Tauri konfigurácia, Rust package a jeho Cargo.lock majú `1.0.0`.
  Súkromný root workspace zámerne ostáva na `0.0.0`.
- Nejde o tag, GitHub Release, merge do main ani dôkaz dokončenej živej orchestrácie.
- Zelená pixelová banka, terminálové opravy z main, licencie, manifest sidecaru
  a oddelenie produkčného/WebDriver buildu zostávajú zachované.

## Preverené lokálne zdroje

1. Záložná vetva `backup/lab-m4-local-20261108`, `bb43f1a4854b621e2e90755d235d74c61e1cc7b4`,
   je postavená na staršom základe. Jej celý snapshot by vrátil opravy z main.
   Posudzoval sa preto iba vlastný diff WIP commitu voči jeho rodičovi.
2. Vybraná a prenesená samostatná oprava: prístupnosť settings dialógu — počiatočný
   focus, návrat focusu, Escape, cyklus Tab/Shift+Tab a názov zatváracieho tlačidla.
3. Veľký WIP redizajn Appearance/Chat/Usage, automatické hľadanie zdrojov,
   nové history parsery, zmeny kurzorov/cache a OpenCode snapshot sa neprenášajú.
   Ide o previazané funkčné zmeny, nie release metadata; starší snapshot navyše
   neobsahuje novšie regresné ochrany. OpenCode snapshot by znovu zapol aktuálne
   bezpečnostne vypnutú funkciu bez požadovaného overenia súbežného WAL.
   Zostávajú zachované v lokálnej zálohe a pôvodnom WIP PR, nie potichu zahodené.
4. Prenesený implementačný snapshot oproti main obsahuje iba tri odlišné súbory:
   denník, orchestračný README a agent-preflight. Necommitnutý experiment
   `--codex-mxc`/sandbox readiness sa neaktivuje vo vydaní; chýba živé Windows
   kompatibilitné overenie a jeho neprítomnosť nesmie predstierať sandbox garanciu.
5. Samostatný vnorený `agent-usage/` nie je zdrojom vydania a nekopíruje sa.
   Používateľove pôvodné súbory a záznamy na PC zostali nezmenené.

## Súkromie Usage

- Žiadny automatický upload, telemetry endpoint ani sieťový klient sa v aktívnej
  Usage ceste nenašiel. Frontend používa iba lokálne Tauri IPC, backend overený
  pribalený sidecar cez stdio a cache v lokálnom app data adresári.
- Nová ochrana samostatného Usage procesu blokuje fetch/WebSocket/EventSource,
  HTTP(S)/HTTP2/TCP/TLS/UDP/DNS, spúšťanie procesov a workerov ešte pred parsermi.
  Je to obrana proti náhodnému odoslaniu dát, nie bezpečnostný sandbox proti
  úmyselne škodlivému JS alebo natívnej knižnici.
- Desktop pred spustením Usage čistí zdedené prostredie; neposkytuje provider auth.
  Autentifikačné zdroje zostávajú zakázané. Normálne údaje sa používateľovi ďalej
  zobrazujú; neboli nahradené fiktívnou spotrebou.
- CSV je iba lokálny Blob/download. Obsahuje skutočné metriky a používateľ ho môže
  sám zdieľať. Aplikácia nedokáže zabrániť vedomému manuálnemu zdieľaniu súboru.
- Z aktuálnej dokumentácie sa odstránili osobné agregáty a konkrétne home cesty.
  Odstránil sa aj starý prázdny vývojový log. Ignorujú sa privátne cache, exporty,
  profily a credential súbory. Publikačný gate kontroluje aktuálny obsah aj archív.
- Všetkých sedem JSON fixtures je syntetických. Jediný Zstandard fixture bol
  rozbalený a overený: umelá session/model, pevný testovací dátum a malé počty.
  Jeho presný SHA-256 je pripnutý v privacy gate. Vizuálne sa preverilo 68 PNG/ICO/
  ICNS assetov: ikony/logá, bez screenshotov osobných dát a bez EXIF/XMP metadát.
- Bežné vzory kľúčov/JWT/private keys sa nenašli. Táto kontrola nie je záruka,
  že ľubovoľné osobné údaje dokáže automaticky rozpoznať.
- Dôležité: už existujúce public commity obsahovali osobné diagnostické agregáty
  v denníku a log-formats. PR odstraňuje ich hodnoty z navrhovaného stromu,
  nevymazáva históriu, iné vetvy, staršie PR ani GitHub cache. Žiadna história
  sa neprepisovala a main zostáva bez zásahu až do rozhodnutia používateľa.

## Overenie

Výsledky platia iba pre príslušný testovaný strom, nie automaticky pre Windows.
Finálny Linux beh 8. 11. 2026, Europe/Bratislava (CET): oficiálny Node
24.22.2 (overený checksum distribúcie), pnpm 10.29.3, frozen lockfile.

| Kontrola | Výsledok |
|---|---|
| `pnpm install --frozen-lockfile` | PASS, exit 0 |
| `pnpm package:usage-sidecar` | PASS, exit 0, nový Linux staging s licenciami/manifestom |
| `pnpm check:release-privacy` | PASS, exit 0, aktuálny strom + rozbalený schválený fixture |
| `pnpm lint` | PASS, exit 0 |
| `pnpm typecheck` vrátane produkčného frontend buildu | PASS, exit 0 |
| `pnpm test` | PASS, exit 0, 119 testov v 36 súboroch |
| `pnpm test:orchestrator` | PASS, exit 0, 22 syntetických/transport kontrakt testov |
| `pnpm --filter wraith exec tsc --noEmit` | PASS, exit 0 |
| Samostatný Rust source-coverage test cez modulový harness | PASS, 3 testy, exit 0 |
| `git diff --check` | PASS, exit 0 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | BLOCKED, exit 101: cargo-fmt nie je na boxe nainštalovaný |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | BLOCKED, exit 101: box rustc 1.85.1 je starší než existujúce zamknuté závislosti vyžadujúce až 1.88 |
| Clippy, celý desktop Rust, Windows GUI/NSIS/inštalácia | NEOVERENÉ na boxe; nové Windows CI musí rozhodnúť |

Prvý nový privacy test mal neúplnú syntetickú udalosť (chýbali povinné cached/
reasoning polia). Opravený bol testovací vstup, nie parser ani assertions;
finálny kompletný beh prešiel. Prvý izolovaný rustc pokus nesprávne kompiloval
vnorený modul ako crate root; správny modulový harness následne prešiel 3/3.
Kontrola prístupnosti settings je zatiaľ source-regression, nie DOM/Windows GUI dôkaz.

- Windows GUI, ConPTY, NSIS a inštalovaný produkčný/automatizačný smoke musí
  overiť nové CI na hlave tohto PR. Staršie zelené behy nie sú dôkaz tejto verzie.
- Živý manager–worker–review cyklus, autentifikácia, approvals a finančné budget
  garancie zostávajú mimo tejto release prípravy. OpenCode čítanie zostáva vypnuté.
- Nový Windows inštalátor zatiaľ nie je zostavený na boxe. Linux frontend build
  ani Linux sidecar scan nie sú Windows runtime alebo čistá inštalácia.
