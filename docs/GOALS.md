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

- **Jeden riadiaci AI model koordinuje viacero AI modelov od rôznych spoločností,
  ktoré pracujú súčasne na tom istom projekte v jednom logickom repozitári.**
  Výber manažéra aj workerov bude flexibilný podľa podporovaných poskytovateľov
  a modelov; cieľ nie je obmedzený na pevnú dvojicu Codex/Grok.
- Manažér rozdeľuje zadania, prideľuje úlohy paralelným workerom, koordinuje ich
  závislosti a priebežne kontroluje výsledky, skutočné diffy a výsledky testov.
  Navrhuje a koordinuje integráciu ich práce do spoločného projektu; to nie je
  prísľub automatického merge do `main`.
- Workeri pracujú nad tým istým repozitárom. Izolované vetvy/worktrees môžu
  predchádzať súbežnému prepisovaniu súborov; nejde o oddelené nesúvisiace
  repozitáre. Prekryté zmeny a konflikty sa riešia explicitne, bez tichého
  prepisovania práce iného workera.
- Kontrola manažérom môže vyžiadať opravy v ohraničenom cykle s explicitným
  limitom. Neúspech alebo chýbajúci dôkaz sa nesmie označiť za hotovú úlohu.
- Súčasťou cieľa sú používateľské schválenia pred chránenými operáciami a
  dostupné **STOP**, ktoré zastaví vlastné procesy manažéra aj všetkých jeho
  workerov. Schvaľovanie, súbežnosť, riešenie konfliktov a ukončenie treba
  overiť v reálnom Windows scenári.
- Spotrebu a limity zobrazovať iba podľa dostupnej overenej telemetrie;
  neznáme údaje priznať. Syntetické tokeny alebo odhady nie sú finančná
  garancia ani presná fakturácia.
- Existujúci transport/preflight a syntetické testy sú podkladom, nie hotová
  živá orchestrácia viacerých súbežných modelov od rôznych poskytovateľov.
  Jej dokončenie zostáva cieľom verzie 1.2. Staršie
  [rozhodnutie o orchestrácii](ORCHESTRATION-DECISION.md) opisuje doterajší
  prototyp a obmedzenia, nie záväzné obmedzenie budúceho výberu modelov.

Tento zápis mení iba ciele. Nezapína nové funkcie, prihlasovanie ani živých agentov.
