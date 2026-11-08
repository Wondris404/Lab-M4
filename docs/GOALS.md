# Goals — plán ďalších verzií Lab-M4

**Stav: plánované ciele, nie hotové funkcie ani prísľub termínu vydania.**
Tento produktový plán dopĺňa starší [technický návrh](PLAN-lab-m4.md).

## Verzia 1.1 — voliteľný konverzačný režim

- Pridať možnosť prepínať medzi terminálom a klasickým chatovým rozhraním
  v štýle ChatGPT: používateľ píše správy a odpovede AI vidí v konverzácii,
  nie ako surový terminálový výstup.
- Chatový režim je určený najmä ľuďom, ktorí nemajú radi terminál.
  Existujúci terminál zostane zachovaný ako plnohodnotná voliteľná cesta;
  chat ho nenahradí povinne.
- Ide o plánovaný doplnkový spôsob práce, nie tvrdenie, že dnešný zabudovaný
  AI chat už funguje. Voliteľný chat spresňuje skoršiu preferenciu práce iba
  cez terminál.

## Verzia 1.2 — AI orchestrátor

- Pridať orchestrátora podľa dohodnutého modelu: **Codex ako manažér →
  Grok Build ako worker → výsledok, skutočný diff a výsledky testov →
  kontrola manažérom → podľa potreby ohraničený opravný cyklus**.
- Manažér rozdelí zadanie, zadá prácu workerovi v izolovanom pracovnom strome
  a posúdi jeho výsledok. Počet opráv bude mať explicitný limit; neúspech alebo
  chýbajúci dôkaz sa nesmie označiť za hotovú úlohu.
- Súčasťou cieľa sú používateľské schválenia pred chránenými operáciami a
  dostupné **STOP**, ktoré zastaví vlastné procesy orchestrátora aj workerov.
  Úplnosť schvaľovania a ukončenia treba overiť v reálnom Windows scenári.
- Spotrebu a limity zobrazovať iba podľa dostupnej overenej telemetrie;
  neznáme údaje priznať. Syntetické tokeny alebo odhady nie sú finančná
  garancia ani presná fakturácia.
- Existujúci transport/preflight a syntetické testy sú podkladom, nie hotový
  živý manažér–worker–review cyklus. Jeho dokončenie zostáva cieľom verzie 1.2;
  podrobnosti a súčasné obmedzenia sú v [rozhodnutí o orchestrácii](ORCHESTRATION-DECISION.md).

Tento zápis mení iba ciele. Nezapína nové funkcie, prihlasovanie ani živých agentov.
