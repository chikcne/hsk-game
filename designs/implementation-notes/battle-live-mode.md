# Battle live-mode (battle-first rework) — implementation notes

## Scope completed

Review Mode is renamed **Battle Mode** and is the main (and only launched)
game mode. The finite review planner, base cursor, recency tiers, persisted
scheduler RNG, and forced repair obligations are removed. Writing/Learn and
Re-Learn remain implemented internally (`src/domain/learn`, `src/domain/relearn`,
`LearnScreen`, `RelearnScreen`) but are disabled/hidden in the UI; their
internals were not touched.

## Paths changed

- `src/shared/battle.ts` (new) — isolated DTO layer for the four approved
  REST endpoints (`VocabRow`, `BattleConfig`, save bundle / open / outcome
  schemas). `config/battle.yaml` is the sole source of runtime tuning and is
  loaded by `src/server/config.ts` for the save routes.
- `src/domain/battle/` (new) — pure, deterministic-under-injected-RNG domain:
  - `pool.ts` — category boundaries (0..50 / 51..99 / 100), the learning-slot
    pool (five lowest-id low rows), benched-row semantics, `isInPool`;
  - `weights.ts` — Hill ratio `n^1.3/(n^1.3+5^1.3)`, shares
    `low = 1 − 0.9r`, mature split .50:.40, renormalization rules;
  - `select.ts` — live spawn draw (category by weight over idle categories,
    uniform member, two RNG draws per call, null when everything is
    active/preparing);
  - `outcome.ts` — `applyMasteryOutcome` (±delta clamped 0..100), the
    client-side mirror of the server update.
- `src/domain/review/` — slimmed to the `reviewWordKey`/`reviewWordIdOf`
  identity helpers (still used by `domain/learn/apply` and RelearnScreen);
  `plan.ts` and `session.ts` deleted.
- `src/client/api/battle.ts` (new) — REST client for the four endpoints,
  built on the storage Worker's shared `HttpFetch` capability
  (`src/client/api/saves.ts`); boot failures surface visibly with retry and
  never substitute an offline or demo bundle.
- `src/client/data/battleDeck.ts` (new, replaces `reviewDeck.ts`) — merged
  full-corpus runtime deck: words keep raw card ids (vocab `card_id` maps
  1:1), duplicate card ids collapse to the earliest deck, meaning/hanzi
  distractor pools stay grade-namespaced. Full membership matters because
  the server refill appends unseen curriculum entries mid-battle.
- `src/client/state/useBattle.ts` — rewritten spawn pipeline: every spawn is
  a live `selectBattleSpawn` draw; mastery/100 is the enemy pressure input
  (`isNewWord` = mastery 0); outcomes POST asynchronously through
  `persistOutcome` (optimistic ±delta locally, authoritative row + refill
  rows merged on response without blocking animation); endless (no
  `sessionComplete`, no pending-work bar); audio preloads only vocabulary
  rows plus appended refill rows; exposes `vocab` + `masteryCounts` for the
  HUD category meter and the final summary snapshot.
- `src/client/app/App.tsx` — battle-first main menu (Battle focused and
  enabled at zero vocab, Writing disabled, Glossary), no grades submenu; boot
  via `GET /api/saves/default`; launch via `POST /battle/open` (seeding) +
  all-deck/stroke loading; whole-save queue/beacon/revision/localStorage
  paths removed; per-card serialized outcome persistence; manual end with
  summary (mastery-category chips replace recency chips); settings dialog
  hides obsolete Learn/session-length controls and renames Review→Battle
  strings.
- `src/client/app/GlossaryScreen.tsx` — reads vocab rows: revealed = row
  exists, tile color = mastery, encounter number = global curriculum
  position (`vocab.id`), drawer shows mastery + mastered-at date.
- `src/client/styles/main.css` — 3-column menu, battle/writing accents,
  stacked mastery-category HUD bar, mastery chips, checkbox-free ranking
  rows.
- `src/shared/constants.ts` — REVIEW_* planner constants removed; settings
  schema comments marked deprecated (fields retained so settings records and
  the storage Worker's tests keep validating).
- `tools/import-strokes/extract.ts` + regenerated
  `public/stroke-data/{ui.json,manifest.json}` — UI bundle extended with the
  13 new menu/HUD characters (对战尽练暂停放未库总览收入).
- Docs: `README.md` rewritten battle-first; status banners + core-flow
  updates in `designs/MAIN.md`, `designs/GAMEPLAY.md`,
  `designs/LEARNING_AND_SAVES.md`.

## Public contracts used/added

- Consumed the storage Worker's REST contract exactly as approved; DTOs are
  shared via `src/shared/battle.ts` (no duplication).
- `HttpFetch`/`HttpFetchLive` imported from `src/client/api/saves.ts`.

## Tests

- `tests/domain/battle.test.ts` (new) — category boundaries, pool membership
  + benched rows + ordered-refill assumption, Hill weights (n=0 → 100% low,
  n=1 ≈ 10% mature, n=7 ≈ 55% mature, r=1/2 at n=5, asymptotes .10/.50/.40),
  renormalization (absent categories, empty low), exclusion/concurrency,
  seeded-RNG determinism + two-draw contract, uniformity, ±10 clamping.
- `tests/client/battle-deck.test.ts` (new, replaces review-deck test) —
  corpus membership, namespaced pools, duplicate-card collapse, audio URL
  resolution, defensive choice generation.
- `tests/client/battle-api.test.ts` (new) — all four endpoints, offline
  rejection, validation failure, and rejection mapping.
- `tests/client/glossary-screen.test.tsx` — vocab-driven fixtures.
- `tests/client/relearn-screen.test.tsx`, `tests/domain/choices.test.ts`,
  `tests/domain/confusables.test.ts` — swapped to `createBattleDeck` /
  local key-scoped deck helper (no Writing-internal changes).
- `tests/integration/runtime.test.ts` — review pipeline replaced by the
  battle pipeline (seed → live selection → deterministic replay →
  exclusions → graduation → ordered refill → weight shift → demotion +
  time_mastered retention), including a pure server-contract simulator.

## Commands run and results

- `npx tsc --noEmit` — 0 errors (whole workspace, including the storage
  Worker's landed server slice).
- `npx vitest run` — 320/321 pass. The single failure is pre-existing and
  environmental: `tests/import-decks/archive-sqlite.test.ts` requires
  `decks/hsk-2-1488171715.apkg`, and `decks/` has zero tracked files at this
  branch's HEAD (removed before this work). The gaussian distribution test
  and the compiled-corpus choices test can flake under full-suite parallel
  load but pass consistently in focused runs.
- `npm run validate:cards` — 5398 cards valid.
- `npm run validate:curriculum` — 5396 entries valid (matches the approved
  duplicate-collapsed count).
- `npm run build` — success (pre-existing >500 kB chunk warning from Phaser).

## Known limitations / follow-ups

- The Selection-Mode close-distractor pool (`poolWords`) is a launch-time
  snapshot; late refill words draw pinyin distractors from the outside pool
  only. Cosmetic; rebuild if it ever matters.
- `WordSessionStats` no longer carries a per-word tier; the summary reads
  mastery categories from the final vocab snapshot.
- Settings retain `levelSize`/`reviewSessionLength` (deprecated, hidden) so
  the settings store keeps validating; dropping them is a storage-Worker
  coordinated change.
