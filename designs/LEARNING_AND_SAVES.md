# Learning scheduler, memory, and local saves

> Status: implemented (save schema v4, Learn Mode + Review Mode + Relearn
> shipped). This document describes the shipping single-card FSRS design
> with Learn Mode as the only path that mutates the main cards, the
> acquired-word Review arcade, and the independent Relearn session. Save v4
> is a fresh start: v3 saves are quarantined, never migrated.

## 1. Model overview

1. **One FSRS card per word/phrase.** The old separate `pinyin`/`meaning`
   memory states are gone. A single card (`ComponentMemory`, mirroring the
   ts-fsrs Card) is each word's whole long-term memory. It is mutated
   exclusively by **Learn Mode's four explicit self-ratings**
   (Again / Hard / Good / Easy) — never by the arcade.
2. **Review battles never touch the main card.** The cross-grade review
   arcade is a retrieval *game* over already-acquired words. It draws
   **solely from the ordered `acquired_words` log** (recency ranks), never
   from FSRS due dates or retrievability; its auto-graded outcomes update
   only session stats and lifetime counters.
3. **Learn sessions are the unit of study.** A grade's click always launches
   Learn Mode — never a battle. An active session persists in the save and is
   resumed exactly.
4. **Relearning is one independent, persisted session.** Lapsed acquired
   words are re-taught with fresh, independent cards stored inside the
   session; finishing a member moves its key to the front of
   `acquired_words`.

Acquisition milestone: the first time a Learn rating leaves a card in FSRS
state `review`, the word enters the ordered `acquired_words` table (see §4).

## 2. Progress records (schema v4)

```ts
// The one card for a word/phrase. Mirrors the ts-fsrs Card exactly; dates
// are ISO strings so the save round-trips losslessly.
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
  card: ComponentMemory;                 // the only memory authority
  learnReviews: number;                  // explicit Learn ratings applied
  lastSeenAt: string | null;             // Learn ratings only (review battles never write word records)
  introducedAtOrdinal: number | null;    // vs the save's global spawnOrdinal
};

type LevelProgress = {
  deckId: DeckId;
  deckFingerprint: string;
  curriculumSeed: string;      // per-profile random hex
  curriculumCursor: number;    // introduced word count
  firstCompletedAt: string | null;      // permanent milestone
  words: Record<WordId, WordProgress>;
  orphanedProgress: Record<WordId, WordProgress>;
};

type LearnSession = {           // logical table: learn_sessions (per grade)
  deckId: DeckId;
  deckFingerprint: string;
  startedAt: string;            // ISO
  wordIds: string[];            // membership, frozen at creation
  completedWordIds: string[];   // members removed by a Review-state rating
};
type RelearnCardState = {        // one member of the active relearn session
  card: ComponentMemory;         // fresh INDEPENDENT card (never the main card)
  reviews: number;               // ratings applied to it this session
};
type RelearnSession = {          // logical table: relearn_sessions (one cross-grade row)
  startedAt: string;             // ISO
  wordKeys: string[];            // selected `deckId:wordId` keys, selection order
  cards: Record<wordKey, RelearnCardState>; // keys match wordKeys exactly
};

type SaveFile = {
  schemaVersion: 4;
  profileId: "default";
  revision: number; savedAt: string;
  settings: { spawnIntervalMs; enemySpeedMultiplier; levelSize; reviewSessionLength; masterVolume; reducedMotion };
  spawnOrdinal: number;                    // global counter (review advances it)
  schedulerRng: [u32, u32, u32, u32];      // global scheduler stream
  levels: Record<DeckId, LevelProgress>;
  acquiredWords: string[];                 // logical table: acquired_words
  learnSessions: Record<DeckId, LearnSession | null>;
  relearnSession: RelearnSession | null;   // the one active cross-grade session
  lifetime: { …review-arcade outcome counters… };
};
```

The old per-word battle counters (`attempts`, `completeCorrect`,
`wrongPinyin`, …) and microspacing ordinals (`lastSpawnOrdinal`,
`nextEligibleSpawn`) are gone: with Learn Mode there is no per-word spawn
cooldown to enforce, and review outcomes no longer write word records.

## 3. Learn Mode

### Session shape

Clicking a grade (or the "learn" column) creates — or resumes — that grade's
active session. A fresh session contains:

1. **every currently due introduced word** of the grade (a card is due when
   its FSRS due date has passed; never-reviewed cards are immediately due),
   in stable curriculum order;
2. **plus up to `settings.levelSize` brand-new curriculum words** (the
   setting is "new cards per session"), pulled in curriculum order and
   introduced immediately (`introducedAtOrdinal` recorded, cursor advanced).

Membership is frozen and persisted. If both sets are empty (every word
introduced, healthy, and not yet due) no session is created; the grade screen
shows an "all caught up" message with the next due time.

### Presentation loop

Each session word is presented with the Writing Screen card: pinyin and
meaning stay visible, word audio auto-plays with a working replay button,
and guided stroke-order writing completes character by character. In Learn Mode, the first
presentation of a word (`card.reps === 0`) starts a looping stroke-order demo
until the player engages; every later appearance starts straight in writing
mode with a **Show Demo** control. Relearn always starts in writing mode with
**Show Demo**, because those words have already appeared to the player. When the writing completes, the card shows
the writing elapsed time (demo-watching excluded) plus the four ratings.

### Ratings and interval previews

The player chooses explicitly: **Again / Hard / Good / Easy** (keys 1–4).
Each button displays the interval that choice will produce, computed live by
applying the rating to a *preview copy* of the card
(`previewLearnCard` + `formatLearnInterval`: `10m`, `1.5h`, `8.0d`). With the
default FSRS-5 parameters (fuzz disabled), a new card lands at roughly
`Again → learning ~1m`, `Hard → learning ~6m`, `Good → learning ~10m`,
`Easy → review ~8d`; a final learning-step pass graduates into review.

Applying a rating (`applyLearnRating`) is one pure, immutable step that:

1. advances the card with FSRS and bumps `learnReviews` / `lastSeenAt` — the
   only place any card is ever mutated (Learn Mode is the only writer;
   review battles are FSRS-write-neutral);
2. when the post-rating card reaches `review`, prepends the word's
   cross-grade key to `acquired_words` **if absent** (exactly-once
   acquisition; later ratings never reorder or duplicate);
3. when the rated word is a session member and its card is now in `review`,
   appends it to the session's `completedWordIds` (rating-time removal);
4. when no un-completed members remain, clears the grade's active session
   (`learnSessions[grade] = null`) — the session is complete.

Every rating is checkpointed through the existing atomic save queue
(`queueSnapshot` → `PUT /api/saves/default`). Learn never touches score,
streak, or lifetime counters.

### Serving order and learn-ahead

The next card is always the **earliest due remaining member** (ties break on
stable word ID). Currently-due cards sort before future ones by definition,
so this single rule gives both the due-first discipline and **Anki-style
learn-ahead**: when nothing is currently due, the earliest future card is
served immediately rather than making the player wait. The session ends only
when every member has been removed by a passing (Review-state) rating — an
Again keeps the card in the session (lapsed to `relearning`) and it recurs
via learn-ahead until it passes.

### Resume

Because membership, completions, and card states are all persisted, clicking
the grade again resumes the exact same session; the served card is a
deterministic function of the persisted state. A mid-session deck update
(fingerprint change) reconciles the level and drops the stale session so the
next launch creates a fresh one.

## 4. Acquired words (logical table `acquired_words`)

`save.acquiredWords` is the ordered acquisition log, newest first. Entries
are cross-grade keys `"<deckId>:<wordId>"` (the same identity the review deck
uses). A word enters **exactly once**, at the moment its main Learn card
first enters FSRS state `review` via a Learn rating; later ratings neither
reorder nor duplicate it. A lapse moves the card to `relearning` but the
word stays in the table. Finishing a Relearn member removes nothing:
the key is **moved to the front** (newest acquisition). The table is the
entry ticket AND the selection order for Review Mode, and the membership
source for Relearn.

## 5. Curriculum

Unchanged hash order over `(curriculumVersion, curriculumSeed,
deckFingerprint, wordId)` with a per-profile random hex seed. `createLevelProgress`
now starts a grade fully unintroduced; introduction happens exclusively
inside `createLearnSession` (or deck reconciliation, which introduces added
words immediately so the next session's due set cannot miss them).

## 6. Review Mode (cross-grade arcade)

Selection is driven entirely by the recency of the acquisition log:

- **Membership**: a word is reviewable iff its key is in `acquired_words` —
  including a word whose main FSRS card later lapses or reschedules. Review
  is unavailable below 20 acquired words; the column shows the acquired
  count, never a due count.
- **Base plan** (`buildReviewPlan`, deterministic, nonpersisted): built once
  at session start from the persisted RNG. At 100+ acquired words it has
  exactly `settings.reviewSessionLength` spawns (integer slider 200–500,
  default 200). Guaranteed quotas: ranks 0–19 ("New") exactly twice each,
  ranks 20–99 ("Recent") exactly once each; every remaining slot draws
  uniformly from rank ≥ 100 ("Old"), falling back to Recent then New. At
  20–99 acquired words, tier boundaries and target length scale by
  `acquiredWords.length / 100` (integer-rounded): 50 words therefore means
  10 New + 40 Recent and 100 default base spawns. Quota and filler entries
  are Fisher–Yates-shuffled together. Duplicate occurrences are sequential,
  never concurrent.
- **Recency drives difficulty, not FSRS**: the label (New/Recent/Old) is
  captured at session start for the summary chips; a 0..1 pressure value
  (`min(rank / min(acquiredCount, 100), 1)`) maps to enemy speed and the
  mastery-adjusted spawn delay. Smaller eligible pools therefore traverse
  the same pressure range proportionally. Global settings still apply.
- **Misses and repairs**: a miss is `wrongPinyin`, `wrongMeaning`, a
  landing, or a pinyin autocomplete/reveal even when the meaning is then
  answered correctly. A missed word enters a delayed repair obligation that
  re-enters the stream after `REVIEW_REPAIR_DELAY_SPAWNS` (10) further base
  spawns, oldest miss first; a later **clean** encounter (typed pinyin,
  correct meaning, no reveal) clears it — whether that encounter is a base
  occurrence or a repair. Obligations that survive the base plan are served
  as **additive forced retries** beyond the slider target (immediately due
  once the plan is exhausted, so lag cannot deadlock the endgame). The same
  word never spawns while an encounter of it is active or preparing.
- **Completion**: the session ends only when every base spawn has resolved,
  no active/preparing enemy remains, and every repair obligation has been
  cleared. The session is **not resumable**; the plan-consumed RNG and
  ordinal advances are checkpointed so a fresh session differs
  deterministically.
- **Summary**: the most-missed words ranked with wrong/miss counts and
  New/Recent/Old chips; struggle rows are selectable (errors preselected)
  and feed **START RE-LEARNING (N)**; **START NEW REVIEW** rebuilds a fresh
  plan; due-based "next review round" semantics are gone.
- **Spawns write nothing**: review cannot mutate FSRS state. Outcomes
  update lifetime counters and the global spawn ordinal, nothing else.

### 6.1 Relearn (the one cross-grade session)

`save.relearnSession` holds THE active relearn session (null when idle):
selected word keys plus a **fresh, independent** `ComponentMemory` and
rating counter per member. Relearn ratings go through `applyRelearnRating`,
which never reads or writes `save.levels`. The presentation reuses the
Learn/Writing UX (pinyin + meaning, immediate writing with an optional **Show
Demo** control and no automatic demo, elapsed writing time, four ratings with
interval previews, earliest-due learn-ahead via `nextRelearnKey`). Each member finishes when
its independent card reaches FSRS `review`: the key is removed from the
session and **prepended to `acquired_words`** (moved to newest/front,
deduped); when the last member finishes the session clears to null.
Progress saves after every rating, so exiting preserves exact state; the
title screen's dedicated Re-Learn column resumes it and is disabled
(visually + `aria-disabled`) when no session exists. Starting a new session
is refused while one is active.

## 7. Save API and validation

Unchanged endpoints (`GET/PUT /api/saves/default`, beacon POST), server-owned
revisions, atomic writer, quarantine/backup recovery. Strict v4 validation
adds, on top of per-field bounds:

- ISO `due` / `lastReview` / `lastSeenAt` / `startedAt`;
- `state !== "new"` ⇒ `lastReview !== null`, positive stability, difficulty ≥ 1;
- due never precedes lastReview;
- learn sessions: key matches grade, fingerprint matches the level, members
  and completions unique, members present in the level record, completions
  ⊆ members;
- `acquired_words`: `deckId:wordId` key format, no duplicates, and (when the
  word record exists) an acquired word's card must be review/relearning with
  at least one Learn rating;
- `relearnSession` (when present): unique `deckId:wordId` keys, every member
  an acquired word, `cards` keys exactly matching the member keys, and each
  independent card following the same memory-shape rules (new ⇔ zero
  ratings; non-new ⇒ lastReview + difficulty/stability bounds + ≥ 1
  rating). Independent cards are never compared against the member's main
  Learn card;
- settings bounds include `reviewSessionLength` (integer 200–500).

**No migrations.** A v3 (or older) file fails validation and follows the
existing corruption flow: quarantine → `.bak` → explicit start-fresh. The
game has not shipped, so no data is converted.

## 8. Invariants

```text
a card satisfies the strict Zod bounds (see §7)
only applyLearnRating mutates a main card; review battles never do
relearn ratings mutate only the session's independent cards, never save.levels
acquired_words is duplicate-free, newest-first, and consistent with card states
relearn members ⊆ acquired_words; relearn cards keys == member keys
learn session members exist in their level; completions ⊆ membership
curriculumCursor >= introduced count and <= deck size
introducedAtOrdinal <= global spawnOrdinal
settings remain in supported bounds
```

## 9. Testing

- `tests/domain/learn.test.ts` — session creation (due + capped new),
  explicit ratings and previews, learn-ahead ordering, exact resume
  (JSON round-trip), acquisition transition/order/dedupe, session completion
  including the due-maintenance repair loop.
- `tests/domain/learning.test.ts` — curriculum order, session-only
  introduction, graduation counting, reconciliation, invariants.
- `tests/domain/memory.test.ts` — single-card FSRS rating behavior,
  acquisition/due-ness predicates, familiarity.
- `tests/domain/review.test.ts` — recency tiers and pressure (full-size
  boundaries 19/20/99/100 plus proportional small-pool boundaries),
  deterministic quotas, the 20-word eligibility boundary, proportional
  base lengths, tier interleaving,
  RNG replay/advance; the spawn-session reducer: delayed repairs (10 base
  spawns), additive forced retries until clean correct, active/preparing
  exclusion, oldest-first draining, base-occurrence clearing, immutability.
- `tests/domain/relearn.test.ts` — independent fresh cards, main-card
  immunity, earliest-due serving with learn-ahead, move-to-front
  acquisition, session clearing, exact resume.
- `tests/domain/workload.test.ts` — 90-day Learn-session simulation:
  finite sessions, bounded backlog, acquisition throughput and ordering.
- `tests/server/*.test.ts` — v4 fixtures, learn-session and acquired-words
  and relearn-session validation, v3 quarantine (no migration), API
  surfaces.
- `tests/client/learn-screen.test.tsx`, `tests/client/relearn-screen.test.tsx`
  — Learn/Relearn screen markup: HUD, looping-demo first presentation vs
  Show Demo later ones, summary states.
- `tests/integration/runtime.test.ts` — learn flow slice and the full
  acquired_words pipeline: plan → battle reducer (miss → forced clean
  repair) → relearn → move-to-front, with the main card untouched.
