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
