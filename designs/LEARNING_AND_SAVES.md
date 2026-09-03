# Learning scheduler, memory, and local saves

> Status: implemented (save schema v3). The pre-FSRS weight-based model
> described here previously is gone; this document describes the shipping
> hybrid FSRS + arcade microspacing design.

## 1. Model overview

The game runs a **hybrid FSRS + arcade microspacing** model:

1. **Long-term memory** is modeled per tested component with
   [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (FSRS-5,
   desired retention 0.9, fuzz disabled for determinism). Every word carries
   **two independent memory states** — `pinyin` (productive recall) and
   `meaning` (recognition) — so a wrong meaning choice no longer discards
   evidence that pronunciation was recalled, and vice versa.
2. **Arcade microspacing** is an independent ordinal constraint
   (`lastSpawnOrdinal` / `nextEligibleSpawn`) against a **global spawn
   ordinal** shared by regular and review modes. A word spawns only when it is
   *due* **AND** *cooled down* **AND** not already an active enemy. The
   cooldown is never bypassed.

A word is **graduated** (the product's "mastered" milestone and the review
deck's entry requirement) only when **both** components have passed their
learning steps into the `review` state. Graduation frees a curriculum slot;
a lapse puts the word back into `relearning` and re-enters the arcade pool
automatically (pool membership is derived, never stored).

Familiarity for arcade presentation (word speed 0.65×–1.5×, spawn-delay
interpolation 160%→40%) is **derived from FSRS state** (`wordFamiliarity`):
0 for new, 0.25 for learning/relearning, logarithmic in stability up to one
year for review. It is a presentation value only and never feeds back into
scheduling.

## 2. Progress records

```ts
// One FSRS card per tested component. Mirrors the ts-fsrs Card exactly;
// dates are ISO strings so the save round-trips losslessly.
type ComponentMemory = {
  state: "new" | "learning" | "review" | "relearning";
  due: string;               // ISO timestamp
  stability: number;         // days
  difficulty: number;        // 0 (new) .. 10
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: string | null;
};

type WordProgress = {
  pinyin: ComponentMemory;
  meaning: ComponentMemory;
  attempts: number; completeCorrect: number; wrongPinyin: number;
  wrongMeaning: number; landed: number;
  totalThinkingMs: number; fastestCorrectMs: number | null;
  totalPinyinMs: number; fastestPinyinMs: number | null; lastPinyinMs: number | null;
  lastOutcome: EncounterOutcomeKind | null;
  lastSeenAt: string | null;
  introducedAtOrdinal: number | null;   // vs the save's global spawnOrdinal
  lastSpawnOrdinal: number | null;
  nextEligibleSpawn: number;            // hard microspacing floor
};

type LevelProgress = {
  deckId: DeckId;
  deckFingerprint: string;
  curriculumSeed: string;      // per-profile random hex: no shared orders
  curriculumCursor: number;
  firstCompletedAt: string | null;      // permanent milestone
  words: Record<WordId, WordProgress>;  // complete record for the grade
  orphanedProgress: Record<WordId, WordProgress>;
};

type SaveFile = {
  schemaVersion: 3;
  profileId: "default";
  revision: number; savedAt: string;
  settings: { spawnIntervalMs; enemySpeedMultiplier; levelSize; masterVolume; reducedMotion };
  spawnOrdinal: number;                    // global spawn counter
  schedulerRng: [u32, u32, u32, u32];      // global scheduler stream
  levels: Record<DeckId, LevelProgress>;
  lifetime: { …outcome counters… };
};
```

The old per-level `nextSpawnOrdinal`/`schedulerRng`, `activeLearningWordIds`,
`reviewedOlderWordIds`, `appearanceWeight`, `reinforcementRemaining`, and the
whole cross-grade `review` section (with its `activePoolWordKeys`) are gone.
Review-mode repairs are per-card FSRS `relearning` state, so stale repair
pools are structurally impossible.

## 3. Automatic FSRS ratings

Every encounter grades up to two components at the resolution timestamp:

| Situation | Pinyin rating | Meaning rating |
| --- | --- | --- |
| Wrong pinyin typed | Again | — (not tested) |
| Pinyin revealed by recall-window timeout (autocomplete) | **Again** | graded normally |
| Correct pinyin, ≤ 800 ms/char (after first exposure) | Easy | graded normally |
| Correct pinyin, normal latency | Good | graded normally |
| Correct pinyin, > 2500 ms/char | **Hard** (still a pass) | graded normally |
| Correct meaning choice ≤ 5 s | — | Good |
| Correct meaning choice > 5 s | — | Hard |
| Wrong meaning choice | — | Again |
| Landed (defensive; unreachable since autocomplete) | Again | Again |

Latency is normalized **per canonical pinyin character**, removing the old
bias against long multi-syllable answers. Easy is used conservatively: a
component with `reps === 0` caps Easy to Good so a first exposure can never
skip the learning steps. Thresholds are hardcoded constants in
`src/domain/memory/ratings.ts` — deliberately not settings.

Struggled (for stats/UI) = any Again or Hard rating. The resolution cooldown
is `AGAIN_COOLDOWN_PHRASES = 3` when any component graded Again, otherwise
`PASS_COOLDOWN_PHRASES = 8`.

## 4. Microspacing (hard ordinal cooldowns)

Spawns consume a single global ordinal series (`save.spawnOrdinal`) so
cooldowns survive crossings between regular and review sessions.

```text
on spawn:     word.lastSpawnOrdinal = s; word.nextEligibleSpawn = s + RESERVED_COOLDOWN_PHRASES + 1
on outcome:   word.nextEligibleSpawn = currentOrdinal + cooldownPhrases (3 or 8)
```

A due word whose cooldown has not elapsed must never spawn. When the
battlefield is empty and the only blocked words are due-but-cooling, the
client advances the global ordinal on its empty-field clock
(`EMPTY_BATTLEFIELD_SPAWN_DELAY_MS` cadence, via `advanceOrdinal`) — cooldowns
elapse in seconds of calm instead of ever being violated. FSRS short-term
learning steps (default ≈ [1m, 10m] learning, [10m] relearning) give roughly
one or two same-session reinforcement tests, then scheduling hands over to
real elapsed time.

## 5. Regular-mode scheduler

Each regular session:

1. tops the **acquisition pool** up to `settings.levelSize` words by
   introducing the next unseen curriculum word whenever the pool has room
   (pool = introduced && not graduated; lapses re-enter automatically);
2. collects candidates: introduced, due (`min(pinyin.due, meaning.due)` ≤
   now), cooled down, not an active enemy;
3. picks by tier priority **relearning → learning → new → review**
   (graduated maintenance), then earliest due, then a uniform RNG pick among
   exact ties;
4. if nothing is eligible, reports:
   - `empty (coolingOnly)` — due words are ordinal-blocked; keep the session
     alive and advance ordinals on the empty-field clock;
   - `empty` — something comes due within `SESSION_WAIT_HORIZON_MS` (120 s);
     wait;
   - `complete` — nothing due within the horizon: **end the session** rather
     than grading not-yet-due cards as fillers.

A fully graduated grade therefore ends a fresh session immediately when none
of its cards are due — continued practice happens in review mode as cards
come due.

## 6. Review mode (cross-grade)

Review sessions serve exactly the due subset of introduced cards that are
graduated or relearning, across all grades:

- relearning repairs first (earliest due);
- graduated maintenance ordered by **lowest retrievability**
  (`fsrs.get_retrievability` on the weaker component);
- rounds are **finite**: when nothing is due the round ends — no fillers, no
  active key pools, no ordinal jumping. The deck-select review column shows
  the honest due count and is disabled at zero.

Un-graduated (`new`/`learning`) words belong to their grade's regular mode
and never appear in review.

## 7. Curriculum

Deterministic hash order over `(curriculumVersion, curriculumSeed,
deckFingerprint, wordId)` — unchanged from the previous design, except the
seed is per-profile random hex (created with `crypto` on first run), so two
players no longer share an introduction order. `curriculumCursor` counts
introduced words; `introduceNewWords` only ever runs during regular play,
never as a side effect of reviewing another grade.

## 8. Completion transitions

After every outcome:

```text
graduated(word)  = pinyin.state === "review" && meaning.state === "review"
grade complete   = every word in the level record is graduated
```

- becoming complete with `firstCompletedAt === null`: set it (permanent) and
  emit `gradeCompleted`;
- a completed grade regressing (any word lapsing): emit
  `gradeMasteryRegressed`; the milestone is never cleared.

## 9. Save API and validation

Unchanged endpoints (`GET/PUT /api/saves/default`, beacon POST). The
persistent schema is v3 with strict component-memory checks: ISO `due`/
`lastReview`, nonnegative integer `reps`/`lapses`/`learningSteps`, finite
`stability`/`difficulty`/`elapsedDays`/`scheduledDays`, `attempts ==
outcome-counter sum`, ordinals before the global `spawnOrdinal`, and
`state !== "new"` ⇒ `lastReview !== null`.

**No migrations.** Save files from earlier schema versions fail validation
and are quarantined (existing corruption flow); the client then starts from a
blank v3 save. The game has not shipped, so no data is converted.

## 10. Corruption and deck reconciliation

Corruption handling is unchanged (quarantine → `.bak` → explicit
start-fresh/download recovery; first PUT with `expectedRevision 0` after an
observed quarantine is the explicit "start fresh" action).

On a deck fingerprint mismatch the client now calls `reconcileLevelProgress`
(matching stable word IDs, preserving memory, orphaning removals, introducing
added words at the current ordinal) instead of silently recreating the level.

## 11. Invariants

```text
component memories satisfy the strict Zod bounds (see §9)
nextEligibleSpawn >= 0, integer; lastSpawnOrdinal < global spawnOrdinal
attempts == completeCorrect + wrongPinyin + wrongMeaning + landed
curriculumCursor <= deck size and >= introduced count
a (re)learning/review/relearning card always records lastReview
firstCompletedAt never changes from a timestamp back to null
settings remain in supported bounds
```

## 12. Testing

- `tests/domain/memory.test.ts` — rating mapping, due-ness, familiarity,
  counter bookkeeping.
- `tests/domain/learning.test.ts` — pool derivation, hard cooldowns (no
  bypass, `coolingOnly`, ordinal advance), horizon-based session end, tier
  priority, graduation transitions, reconciliation, invariants.
- `tests/domain/review.test.ts` — due-only finite rounds (filler-bug
  regression), relearning priority, retrievability ordering, stale-pool
  impossibility, cross-mode cooldown reservation.
- `tests/domain/workload.test.ts` — 90-day seeded simulation of the real
  scheduler + FSRS with a retrievability-driven synthetic player: bounded
  backlogs, finite sessions, stability growth, graduation throughput, no
  card regressing to unseen state.
