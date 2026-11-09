# Lab-M4 1.2.1 (early) — orchestrátor UX

Skorá verzia nad 1.2.0. Čísla verzií v súboroch sú čisté `1.2.1`, lebo Windows
MSI (WiX) neprijíma textovú príponu ako `-early`; označenie „early“ je iba tu,
v PR a v názve vydania. Nejde o tag ani GitHub Release.

## Novinky

- **Okno orchestrátora nad terminálom alebo chatom.** Klik na Orchestrátor nechá
  otvorený bežný pohľad podľa režimu aplikácie a nad ním otvorí malé okno:
  orchestrátor (firma + model), zadanie, projekt, súbory a výber workerov.
  Schválenia sa v ňom zobrazia aj s dôvodom, prečo orchestrátor vybral danú AI.
- **Nastavenia → Orchestrátor.** Predvolený orchestrátor, automatický alebo ručný
  výber workerov a zoznam 2–8 AI od rôznych firiem, z ktorých orchestrátor vyberá.
- **Aktivita agentov.** Panel pod terminálom ukazuje živo, čo robí orchestrátor
  a každý worker (plán, pridelenie a dôvod, štart, výsledok s +/− riadkami, testy,
  posúdenie, opravy, integrácia, koniec), s označením agenta, modelu a farbou
  firmy. Viac workerov naraz má živú legendu stavov. V režime chatu sa rovnaké
  udalosti zobrazujú ako prehľadný zoznam.

## Technicky

- Jadro orchestrátora posiela udalosti cez `onEvent`; Rust drží posledných 4000
  udalostí behu a `orchestration_snapshot` vracia iba nové (`since`).
- Výstup modelov sa pred zobrazením v termináli zbaví riadiacich znakov.
- Deterministická simulácia behu (`packages/orchestrator-core/testing`) slúži
  iba testom; produkčný most ju neimportuje.

## Overenie

- Na Linux boxe: typecheck, build, lint, privacy gate, vitest, orchestrátorové
  testy, `cargo fmt` a `cargo clippy` pre Windows cieľ. Reálne AI CLI, Windows GUI
  a inštalátory overuje Windows CI; živý beh s modelmi zatiaľ overený nie je.
