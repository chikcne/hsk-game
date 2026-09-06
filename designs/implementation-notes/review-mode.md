# Review Mode + Relearn handoff (third slice of the rewrite)

## Scope completed

The acquired-words **Review Mode** and the independent **Relearn workflow**
are fully implemented and shipped.

Review Mode now draws **solely from `save.acquiredWords`** (the logical
`acquired_words` recency log, newest first). FSRS due dates, states, and
retrievability play no part in selection, and battle outcomes still never
mutate any main Learn card — only lifetime counters, the global spawn
ordinal, and the RNG advances get checkpointed.

At session start the app builds a **deterministic, nonpersisted base plan**
(`buildReviewPlan`). Review requires at least 20 acquired words. At 100+
words, the plan has exactly `settings.reviewSessionLength` spawns (integer
slider 200–500, default 200):

- ranks 0–19 ("New"): exactly 2 occurrences each;
- ranks 20–99 ("Recent"): exactly 1 each;
- every remaining slot: uniform random draw from rank ≥ 100 ("Old"),
  falling back uniformly to Recent, then New;
- from 20–99 words, tier boundaries, pressure, and base length scale by
  `acquiredWords.length / 100` (for example, 50 words means 10 New + 40
  Recent and 100 default base spawns);
- guaranteed + filler entries are Fisher–Yates-shuffled together, so tiers
  interleave while counts are exact; duplicates are sequential and never
  concurrent;
- the plan consumes the persisted RNG once; the advanced snapshot is
  checkpointed immediately so restarted sessions differ deterministically.
  The session itself is **not resumable**.

Recency labels (New/Recent/Old at full-size boundaries 19/20/99/100) are
captured at session start into per-word stats and shown as summary chips.
Spawn pressure interpolates `min(rank / min(acquiredCount, 100), 1)`, so an
eligible pool below 100 scales the same difficulty range proportionally. It
drives enemy speed and the mastery-adjusted spawn delay; global settings and
the live performance multiplier still apply.

A **miss** is wrongPinyin, wrongMeaning, landed, or a pinyin
autocomplete/reveal — even when the meaning is then correct. Misses enter a
delayed repair obligation (`REVIEW_REPAIR_DELAY_SPAWNS = 10` further base
spawns; oldest miss first) that clears on the first later **clean** (typed
pinyin + correct meaning + no reveal) encounter, whether base or repair.
Obligations surviving the base plan become **additive forced retries**
beyond the slider target — immediately due once the plan is exhausted, so
lag cannot deadlock the endgame. Review ends only when all base spawns
resolved, no active/preparing enemy remains, and every obligation is
cleared; a prepared/active final enemy prevents premature completion.

The summary ranks the most-missed words (wrong/miss counts + recency chip),
offers selectable struggle rows (errors preselected) and **START
RE-LEARNING (N)** (omitted for a perfect round, refused while a relearn
session is active), plus **START NEW REVIEW** (fresh plan) and **RETURN**.
Due-based NEXT REVIEW ROUND semantics are removed; the Review column is
enabled at 20 acquired words and shows the acquired count.

**Relearn** replaces the placeholder: ONE cross-grade persisted session
(`save.relearnSession`, logical table `relearn_sessions`) storing selected
keys and fresh **independent** per-member FSRS cards + counters. Ratings go
through `applyRelearnRating` (never touches `save.levels`), use the same
Learn/Writing UX (pinyin+meaning, immediate writing with optional Show Demo,
elapsed time, four ratings with interval previews, earliest-due learn-ahead via
`nextRelearnKey`), and save after each rating (exact resume). A member
finishes when its independent card reaches Review: the key is removed from
the session and **prepended to `acquired_words`** (moved to newest/front,
deduped); the last finish clears the session to null. The title screen's
dedicated **RE-LEARN / 重学** column (7th of 9) resumes it and is visually +
semantically disabled when none exists.

Navigation is now 9 columns (Next Learn, HSK 1–6, Re-Learn, Review) with
wrap-around arrow navigation, Home/End, focusable-but-refused disabled
columns, and unchanged 1–6 grade shortcuts. Schema stays **v4, fresh
start**; `relearnSessions` (per-grade record) was replaced by the single
`relearnSession` field and settings gained `reviewSessionLength`. Strict
server validation now enforces acquired-key dedupe/catalog coherence and
relearn key/state/counter/subset invariants — never equality between
relearn cards and main cards.

## Paths changed

```text
src/shared/constants.ts                     # REVIEW_* tier/repair constants, reviewSessionLength default
src/shared/schemas.ts                       # settings slider bound; RelearnCardState/RelearnSession schema; save root relearnSession
src/domain/review/plan.ts                   # NEW: buildReviewPlan(FromSnapshot), recency labels, pressure
src/domain/review/session.ts                # NEW: pure spawn/obligation reducer (decide/reserve/apply/settled)
src/domain/review/types.ts                  # key helpers only; scheduler.ts DELETED (FSRS-due selection removed)
src/domain/relearn/index.ts                 # NEW: createRelearnSession, nextRelearnKey, applyRelearnRating
src/domain/session/speed.ts                 # recency-pressure speed mapping (wordSpeedMultiplier removed)
src/client/state/useBattle.ts               # plan-driven spawns, obligation bookkeeping, resolved-count progress, autocomplete-as-miss, servedRef removed
src/client/data/reviewDeck.ts               # createReviewDeck(decks, keys) — acquired/relearn keys membership exactly
src/client/app/App.tsx                      # deployReview via plan, deployRelearn/rateRelearn/startRelearn, 9-column DeckSelect, summary rework, settings slider
src/client/app/RelearnScreen.tsx            # NEW: relearn screen + summary
src/client/styles/main.css                  # 4-column scroll-menu grid, relearn/disabled column styles, ranking rows, recency chips
src/client/api/saves.ts                     # blankSave relearnSession: null
src/server/saves/repository.ts              # v4 default save relearnSession: null
src/server/saves/validation.ts              # strict relearnSession schema + invariants; reserved-null check removed
tools/import-strokes/extract.ts             # UI_HANZI_TEXT += 重学巩固错无已得行中
public/stroke-data/ui.json + manifest.json  # 9 UI characters added (copied from hsk-6 bundle), checksums refreshed
README.md, designs/LEARNING_AND_SAVES.md, designs/MAIN.md, designs/UI_SPEC.md, designs/TEST_PLAN.md, designs/GAMEPLAY.md
tests/domain/review.test.ts                 # rewritten: plan quotas/boundaries/fallbacks/determinism + reducer retry/exclusion/completion suites
tests/domain/relearn.test.ts                # NEW
tests/client/relearn-screen.test.tsx        # NEW (SSR markup)
tests/server/helpers.ts                     # makeSnapshotWithRelearn / makeSnapshotWithAcquiredWord fixtures
tests/server/{saves,api}.test.ts            # relearn validation + API acceptance fixtures
tests/domain/{learn,session,workload}.test.ts, tests/integration/runtime.test.ts, tests/client/learn-screen.test.tsx
                                            # relearnSession: null fixtures; session.test wording (recency pressure)
tests/integration/runtime.test.ts           # full pipeline test: learn → acquire → plan → battle (miss last spawn → forced repair) → relearn → move-to-front
```

`src/client/writing/**` was NOT touched (owned by another agent).

## Public contracts used/added

- `buildReviewPlanFromSnapshot(acquiredWords, targetLength, snapshot)` →
  `ReviewPlan { spawns, recency, pressure, snapshot }` (deterministic,
  nonpersisted; `buildReviewPlan` is the RNG-state variant).
- `createReviewSession(plan)` / `decideReviewSpawn(session, activeKeys)` /
  `reserveReviewSpawn` / `applyReviewOutcome` / `isReviewSessionSettled` —
  the pure spawn/obligation reducer used by `useBattle`.
- `createReviewDeck(decks, wordKeys, { title? })` — merged presentation
  deck for exactly the given `deckId:wordId` keys.
- `createRelearnSession(keys, now)`, `nextRelearnKey(session, now)`,
  `applyRelearnRating(save, key, rating, now)` →
  `{ save, card, keyFinished, reacquired, sessionCompleted }`.
- Save v4 root: `relearnSession: RelearnSession | null`;
  `settings.reviewSessionLength` (int 200–500, default 200).
- Constants: `REVIEW_NEW_TIER_RANK_LIMIT=20`,
  `REVIEW_RECENT_TIER_RANK_LIMIT=100`, `REVIEW_REPAIR_DELAY_SPAWNS=10`.

## Commands run and results

```text
npm test        # typecheck + 27 files / 232 tests pass
npm run build   # typecheck + vite build pass
```

Live API smoke (temp dir): first-run GET returns v4 with
`relearnSession: null` and `reviewSessionLength: 200`; a PUT with a
coherent active relearn session is accepted (revision 1); an incoherent
one (non-acquired member, member/card mismatch) is rejected 400 with
precise issue paths.

## Key semantics (for the next agent)

1. Review selection NEVER reads FSRS. If you touch spawning, keep the plan
   + obligation reducer (`src/domain/review/session.ts`) the only selector;
   `useBattle` merely executes its decisions each frame.
2. Progress is **resolved spawns** over committed work (unreserved base
   spawns + open obligations not already in flight + in-flight enemies),
   never unique words seen. Autocomplete is a MISS with a retry obligation:
   the encounter resolves (the meaning answer stands, play continues) but
   scores **zero points**, **resets the streak**, is excluded from the
   summary's clean-recall accuracy, and the HUD shows a
   "PINYIN REVEALED · MEANING SAVED" notice — never "DIRECT HIT". Lifetime
   `completeCorrect` still counts it (the enemy was completed correctly).
3. Repair delay counts further base spawns reserved since the miss; once
   the base plan is exhausted repairs are due immediately (additive,
   forced). A clean correct encounter of ANY kind clears an obligation.
4. Relearn cards are independent by design: validation and domain code
   must never sync them with `save.levels`.
5. The nine-column rail: disabled columns stay focusable (aria-disabled)
   but refuse activation; keep Home/End and the 1–6 shortcuts working.

## Known limitations / follow-ups

- Review summaries and the relearn screen are covered by SSR markup tests,
  not browser E2E (fits the later P9 slice).
- A deck update that removes an acquired word drops it from the review
  pool (plan filters to presentable keys) and from an active relearn
  session on resume (pruned defensively).
- Old-tier fillers are uniform per draw; a shuffled Old subqueue (sampling
  without replacement per cycle) could further even coverage.

## Selection Mode (pinyin by button) — fourth-slice addition

Review Mode's pinyin phase can now be answered by **selecting** syllables
instead of typing them. Two persisted settings drive it:

- `settings.desktopReviewMode` and `settings.mobileReviewMode`, values
  `"selection" | "typing"`, **default `"typing"`** (current behavior
  preserved). The settings dialog exposes them under REVIEW MODE as the
  exact dropdowns **Desktop Review Mode** / **Mobile Review Mode** with
  options **Selection Mode** / **Typing Mode**.
- Portrait orientation applies the mobile setting, landscape the desktop
  one (`App.tsx` `usePortraitOrientation`). The effective mode is **locked
  per enemy** inside `useBattle.commitEnemies`: orientation rotations and
  mid-battle settings changes take effect on the NEXT target and never
  erase an in-progress answer.
- Schema-v5 saves written before these fields hydrate with typing defaults
  via zod `.default()` — on the client (`parseSavePayload`) and the strict
  server schema alike — with all progress retained and no revision bump.

### Compiled pinyin segmentation

`RuntimeWord` gained `pinyinSegments: string[][]` — exactly one entry per
Han character, grouped alternatives per entry (谁 → `[["shéi","shuí"]]`;
contracted erhua 这儿/zhèr → `[["zhè"],["r"]]`). It is **derived at compile
time** (`tools/import-decks/normalize/pinyin-segments.ts`) from the
authored `.acard` pinyin; no gameplay-time `.acard` reads and no
hand-authored segment fields on source cards. Hanzi pronunciation data
(pinyin-pro) is used ONLY to find syllable boundaries — tone-insensitive
alignment plus a no-tone Mandarin syllabary fallback (pinyin-pro reads
膀 páng while the corpus authors bǎng). Authored pronunciation is never
replaced: tone sandhi (yíkuàir), neutral tones (shāngliang), apostrophes
(nǚ’ér), separators (shízì lùkǒu, suān-tián-kǔ-là) and capitals
(Zhōnghuá Mínzú) are reproduced verbatim, enforced by a reconstruction
check. A card that cannot be segmented **fails the compile** (both
`from-cards` and the `.apkg` normalize path) and `validate:cards --deep`.
Deck identity is untouched: the fingerprint digests authored content only,
so the regenerated bundles keep their fingerprints.

### Choice generation and sourcing rules

`src/domain/session/pinyin-choices.ts` is a pure deterministic generator.
Each Han-character step of the locked target returns exactly **8 unique
labels**: 1 correct (all authored alternatives grouped on one button),
**4 distractors from pinyin segments of other unique words in the current
Review plan**, and **3 from loaded deck words outside the plan**. Correct
alternatives, the target word's own syllables, and duplicate labels are
excluded. Positions are Fisher–Yates shuffled from a seed of **enemy id +
character index**, so every character of every enemy draws fresh choices.
If a plan pool cannot supply 4 unique eligible labels, it backfills from
outside to keep 7 false choices; pathological fixtures degrade safely
while always including the correct label. `App.deployReview` builds the
pools (unique plan words + all loaded words outside the plan) and hands
them to `useBattle` via `BattleOptions.pinyinPoolWords`.

### Gameplay

`src/domain/session/pinyin-selection.ts` holds the pure progress reducer;
`useBattle` resets it on locked-target changes and feeds every click.
Correct clicks append the displayed segment and advance; the final
correct segment enters the existing meaning phase, plays audio, and shares
clean scoring/repair rules with correctly typed pinyin. A wrong click
immediately resolves the existing `wrongPinyin` outcome and feedback,
carrying the selected sequence plus the wrong label. The pinyin recall
timeout is unchanged — partial selection at the deadline reveals the full
pinyin, enters meaning, and records a miss. There are **no letter/number
pinyin hotkeys**; buttons work through normal focus + Enter/Space, and
meaning hotkeys are unchanged. Selection is disabled during pause and
corrective feedback, and the hidden typing input's focus enforcement is
Typing-Mode-only.

### Responsive layout

Desktop (both modes) reserves `66px / minmax(280px, 1fr) / 220px` rows in
the pinyin phase — the answer-track reservation is what shrinks the
battlefield; lanes, normalized positions, landing boundary, type scale,
and travel timing are unchanged, and the meaning phase still grows for
long text. Mobile Typing Mode keeps the 246px QWERTY region; Mobile
Selection Mode swaps that region's contents for the 4×2 selector grid
(selected pinyin displayed in the answer card above) with the arena height
stable.

### Paths changed (this slice)

```text
src/shared/constants.ts                       # desktopReviewMode/mobileReviewMode defaults
src/shared/schemas.ts                         # ReviewInputMode settings (.default("typing")), RuntimeWord.pinyinSegments + per-character refine
src/client/app/App.tsx                        # orientation hook, pools, selector render, typing-focus guards, settings dropdowns
src/client/app/PinyinSelector.tsx             # NEW: SelectedPinyin + PinyinChoiceGrid
src/client/state/useBattle.ts                 # locked input mode, selection progress/state, choosePinyin, selection view
src/client/styles/main.css                    # 220px desktop answer track, selector + touch-selector styles, select styling
src/client/data/demoDeck.ts                   # demo pinyinSegments fixtures
src/domain/session/pinyin-choices.ts          # NEW: pure 8-choice generator + label pools
src/domain/session/pinyin-selection.ts        # NEW: pure per-character progress reducer
tools/import-decks/normalize/pinyin-segments.ts  # NEW: compile-time segmentation (pronunciation-boundary alignment + syllabary fallback)
tools/import-decks/normalize/words.ts         # .apkg path derives pinyinSegments (typed failure)
tools/import-decks/compile/from-cards.ts      # cards path derives pinyinSegments (typed failure)
tools/import-acards/extract.ts                # recovery path carries segments through
tools/import-acards/validate.ts               # --deep re-derives segments for every card
public/game-data/**                           # regenerated bundles (fingerprints unchanged)
tests/import-decks/pinyin-segments.test.ts    # NEW: explicit cases + full 5,398-word corpus validation
tests/domain/pinyin-choices.test.ts           # NEW: 8 labels, 4/3 provenance, exclusions, determinism, fallback
tests/domain/pinyin-selection.test.ts         # NEW: advance/complete/wrong/alternatives/erhua r
tests/client/pinyin-selector.test.tsx         # NEW: SSR markup, a11y, no-hotkey contract, disabled state
tests/client/saves.test.ts, tests/server/saves.test.ts  # legacy hydration + strict roundtrip
```
