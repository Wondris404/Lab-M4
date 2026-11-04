# Lokálne formáty: prieskum 4. 11. 2026

Toto je pozorovanie malého počtu lokálnych súborov, nie stabilná špecifikácia.
Podrobný prehľad celého disku sa nerobil. Pre SQLite sa použilo read-only otvorenie
s `immutable=1`, takže výsledok nemusí zahŕňať ešte nezapísaný WAL.
Súbory agentov sa nemenili. Autentifikačné súbory, prihlasovacie údaje a súbory
s názvami obsahujúcimi auth, credential, token, secret, key, login alebo .env
neboli cieľom čítania. Súkromné správy ani názvy projektov nie sú vo vzorkách.

Vzorky v fixtures/ sú syntetické: časy a počty nie sú reálne používateľské údaje. Zachovávajú iba vybrané polia bez osobného obsahu a skutočných identifikátorov.

## Codex

- Cesta: `%USERPROFILE%\.codex\archived_sessions\*.jsonl.zst`.
  Existuje aj `%USERPROFILE%\.codex\sessions\`; jeho hlbšie uložené
  súbory sa v tomto prieskume neotvárali.
- Formát: JSONL komprimovaný Zstandard. Overené na jednom archívnom súbore.
- Čas: vrchné `timestamp`. Relácia: `session_meta.payload.session_id` a `id`.
  Model: `turn_context.payload.model`, nie priamo v udalosti spotreby.
- Spotreba: `event_msg.payload.type = token_count`;
  `payload.info.last_token_usage` a `total_token_usage` obsahujú
  `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens`, `reasoning_output_tokens`, `total_tokens`.
  Celkové a posledné počty nemožno automaticky sčítať bez overenia významu.
- Limity: v skúmanej udalosti existuje `payload.rate_limits`, vrátane
  `primary` a `secondary` s `used_percent`, `window_minutes` a
  `resets_at`. Dostupnosť a význam jednotlivých hodnôt sa môžu líšiť.
- Skutočná cena: v skúmanej tokenovej udalosti nebola potvrdená. To nedokazuje,
  že neexistuje inde.
- Oficiálna [dokumentácia OpenAI k miestnej konfigurácii](https://developers.openai.com/codex/local-config)
  bola skontrolovaná; presné umiestnenie a schéma týchto udalostí ňou neboli potvrdené.
  Vyššie uvedená cesta a polia sú výsledkom miestneho pozorovania.
- Vzorky: `fixtures/codex/usage-1.json`, `usage-2.json`.

## Grok Build

- Cesty: `%USERPROFILE%\.grok\logs\unified.jsonl` a
  `%USERPROFILE%\.grok\sessions\session_search.sqlite`.
  V priečinku sessions existujú aj podpriečinky relácií, ktoré sa neotvárali.
- Formát: JSONL log; SQLite vyhľadávací index.
- JSONL: vrchný čas `ts`, identifikátor `sid`; kontext môže obsahovať
  `ctx.sessionId` alebo `ctx.session_id` a polia modelu vrátane
  `ctx.model_id`, `ctx.canonical_model`, `ctx.model`. Nie sú zaručené
  spolu v jednej udalosti.
- Vo vybranom zázname sú `ctx.prompt_tokens`, `ctx.cached_prompt_tokens`,
  `ctx.completion_tokens`, `ctx.reasoning_tokens`. Ich presná agregácia,
  spojenie s modelom a jednotka udalosti vyžadujú ďalšie overenie.
- SQLite index má `session_docs.session_id` a `updated_at`; jeho obsahové
  stĺpce sa nepoužili na vzorku. Index sám o sebe nie je potvrdený zdroj ceny.
- Skutočná cena a použiteľné hodnoty limitov neboli v skúmanom zdroji potvrdené.
  Prítomnosť názvov polí v iných udalostiach nepreukazuje kompletný limit.
- [Oficiálna dokumentácia Grok Build](https://docs.x.ai/build/cli/headless-scripting)
  uvádza `~/.grok/sessions` pre headless relácie. Formát JSONL a jeho polia
  vyššie sú lokálne pozorovanie, nie záruka dokumentácie.
- Vzorky: `fixtures/grok-build/usage.json`, `metadata.json`.

## OpenCode

- Cesta: `%USERPROFILE%\.local\share\opencode\opencode.db`; SQLite.
  [Oficiálna dokumentácia OpenCode](https://opencode.ai/docs/troubleshooting/)
  uvádza túto základnú cestu a databázu; vlastná konfigurácia ju môže zmeniť.
- Tabuľka `session`: `id`, `time_created`, `time_updated`, `model`,
  `tokens_input`, `tokens_output`, `tokens_reasoning`,
  `tokens_cache_read`, `tokens_cache_write`, `cost`.
  Ukážkové časové hodnoty sú číselné milisekundy od epochy.
- Tabuľka `message`: `session_id`, `time_created`, `data` (JSON);
  v skúmaných JSON objektoch existujú `modelID`, `tokens.input`,
  `tokens.output`, `tokens.reasoning`, `tokens.cache.read`,
  `tokens.cache.write` a `cost`. Nie každá správa musí mať všetky polia.
- `cost` je v zdroji uložené číselné pole, ale jeho mena, spôsob výpočtu a
  zhoda s reálnou fakturáciou v tomto prieskume neboli overené. Neoznačovať ho
  automaticky ako skutočne zaplatenú cenu. Limity neboli overené.
- Význam cache vo vzťahu k input a vzťah súčtov session/message treba overiť,
  aby nedošlo k dvojitému započítaniu.
- Vzorky: `fixtures/opencode/session.json`, `message.json`.

## Antigravity CLI

- Existuje `%USERPROFILE%\.gemini\antigravity-cli\conversation_summaries.db`
  a priečinok `%USERPROFILE%\.gemini\antigravity-cli\conversations\`.
  Prieskum obsahu conversation súborov v hlbších podpriečinkoch sa nerobil.
- Databáza je SQLite; skúmaná tabuľka `conversation_summaries` má
  `conversation_id` a `last_modified_time`. Ide o index súhrnov, nie
  preukázaný tokenový záznam.
- Model, vstupné, cache, výstupné a reasoning tokeny, cena ani limity neboli
  v tejto tabuľke preukázané. Nedá sa preto tvrdiť, že inde neexistujú.
- [Oficiálna dokumentácia Antigravity CLI](https://antigravity.google/docs/cli/conversations)
  opisuje relácie; [oficiálny changelog](https://antigravity.google/docs/changelog?ide=visual-studio&tab=extensions)
  spomína SQLite formát konverzácií. Názov konkrétnej lokálnej databázy a
  jej stĺpce pochádzajú z miestneho pozorovania.
- Vzorka: `fixtures/antigravity/metadata.json`; iba časové metadáta, žiadne tokeny.

## Riziká pred implementáciou

Model sa môže nachádzať v inej udalosti než spotreba; časť dát alebo WAL nemusí
byť viditeľná; počty môžu byť kumulatívne, čiastkové alebo prekrývajúce sa.
Vzorky nepreukazujú jednotky ceny ani fakturačnú presnosť. Zmeny verzií môžu
schému zmeniť. Pred návrhom parserov treba overiť tieto vlastnosti bez prístupu
k tajomstvám a s ďalšími redigovanými príkladmi. Parsery v tejto vetve zostali stuby.

## Dodatočné overenie tokenov

- Codex: vo vzorkách total_tokens = input_tokens + output_tokens; OpenAI opisuje cached input a reasoning ako detaily zodpovedajúcich celkov: https://developers.openai.com/api/reference/resources/responses/methods/create. Celkové počty sú kumulatívne.
- Grok Build: oficiálna dokumentácia https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing uvádza cache v detaile prompt a reasoning v detaile completion. Zo 853 lokálnych udalostí s oboma počtami cache nikdy nepresahovala prompt a reasoning nikdy nepresahoval completion. Deduplikácia ani prepojenie modelu sa ešte neoverili.
- OpenCode: z 1 017 objektov message.data.tokens malo 1 002 pole total; pri 996 platilo total = input + output + reasoning + cache.read + cache.write. V 899 prípadoch cache.read presahovalo input a v 87 reasoning presahovalo output. Pre tieto záznamy teda nejde vždy o podmnožiny. Pri šiestich záznamoch s total sa rovnica nepotvrdila a treba preskúmať aj chýbajúce hodnoty; význam sa môže líšiť podľa verzie a poskytovateľa.

Vyššie uvedené počty sú diagnostika sémantiky, nie výsledok parsera.

## Implementované čítanie a obmedzenia

Parsery vracajú records spolu s počtom warnings, samostatnými limits a agregátmi mismatchFields. Codex číta JSONL a streamované JSONL.zst, používa last_token_usage a vynechá opakovaný kumulatívny stav relácie. Limitné okná sú oddelené od UsageRecord. Model a výslovné pole speed prichádzajú z posledného turn_context; inak je rýchlosť unknown.

OpenCode otvára SQLite pomocou mode=ro a immutable=1 a vyberá iba potrebné polia cez json_extract; ignoruje WAL, ktorý ešte nebol zapísaný do databázy. Pre každú reláciu preferuje správy; súhrn session použije iba ak nemá žiadnu správu s tokenovým objektom. Podľa zadania normalizuje input = input + cache.read + cache.write, cached input = cache.read, output = output + reasoning. Nesúhlasné total sa importuje a pridá warning a kategóriu rozdielu. Chýbajúce alebo neplatné povinné počty nemožno bezpečne normalizovať a záznam sa s warning vynechá. Uložené cost sa označí odhad; jeho mena a skutočná fakturácia ostávajú neoverené.

Grok číta JSONL po riadkoch; lokálne overený typ s počtami je shell.turn.inference_done. Páruje kontext podľa sid a deduplikuje presné opakovania podľa sid, loop_index, času a tokenových počtov. Ak session ID nie je výslovne prepojené v kontexte, použije sessionId aj model unknown; sid slúži ako korelačný identifikátor, nie automaticky ako relácia. Overenie voči indexu našlo zhodu troch z 25 korelačných identifikátorov, čo nepotvrdzuje zvyšné. Pri zmene logovacieho formátu alebo opakovaní tej istej požiadavky s odlišným časom treba deduplikáciu znovu overiť. Pri chýbajúcich povinných poliach sa položka preskočí s warning.

Server číta config/settings.json, spúšťa iba enabled zdroje a pri chýbajúcej zaznamenanej cene skúsi cenník podľa známej rýchlosti; bez platnej sadzby je cena neznáme. V EUR použije nastavený kurz. Čiastočný súčet ceny je označený costIncomplete. Žiadne správy alebo prompty sa nevracajú ani neukladajú. Antigravity ostáva prázdny stub.

Pri šiestich lokálnych nezhodách OpenCode je celkové pole total vždy menšie ako súčet input, output, reasoning, cache.read a cache.write. Všetkých šesť má nenulové reasoning, štyri nenulové cache.read, žiadny nenulové cache.write. Odčítanie iba jediného z týchto piatich komponentov nesúlad nevysvetlilo; konkrétne chybné pole nemožno z uvedených agregátov určiť.
