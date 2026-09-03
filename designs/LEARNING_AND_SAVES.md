# Learning scheduler, mastery, and local saves

## 1. Terminology

Words move through an explicit spaced-repetition pipeline with four phases:

- `new` — introduced into the pool but never tested;
- `learning` — walking the fixed learning steps (ordinals);
- `review` — graduated into long-term review (wall-clock `dueAt`);
- `relearning` — a graduated word that lapsed and repeats the relearning steps.

A word is **mastered** exactly while it is in `review`. A level's **live mastery**
is complete only when every logical word is graduated. A permanent
`firstCompletedAt` milestone records that the level was beaten at least once.
If a graduated word later lapses, live mastery regresses until it re-graduates,
but the earned cleared milestone remains.

Displayed mastery is a smooth, player-facing value derived from stage and
stability — it never drives scheduling or spawn pacing:

```text
New                0%
Learning step 1   25%
Learning step 2   50%
Learning step 3   75%
Graduated review  80 + 20 * stability / (stability + 7), saturating at 100%
```

This is intentionally Anki-like rather than a reuse of Anki's card scheduling.
Source cards and review history are not imported.

## 2. Progress records

```ts
type WordProgress = {
  phase: "new" | "learning" | "review" | "relearning";
  stepIndex: number;              // index into the active phase's steps
  dueOrdinal: number | null;      // intra-session due point (learning/relearning)
  dueAt: string | null;           // wall-clock due point (review)
  stability: number;              // long-term memory stability in days
  difficulty: number;             // 1 (easy) .. 10 (treacherous)
  lapses: number;
  lastGrade: "again" | "hard" | "good" | "easy" | null;
  attempts: number;
  completeCorrect: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  totalThinkingMs: number;
  fastestCorrectMs: number | null;
  totalPinyinMs: number;
  fastestPinyinMs: number | null;
  lastPinyinMs: number | null;
  lastOutcome: EncounterOutcomeKind | null;
  lastSeenAt: string | null;      // ISO timestamp, display/statistics only
  introducedAtOrdinal: number | null;
  lastSpawnOrdinal: number | null;
  nextEligibleSpawn: number;      // absolute ordinal: hard spacing floor
};

type LevelProgress = {
  deckId: DeckId;
  deckFingerprint: string;
  nextSpawnOrdinal: number;
  schedulerRng: [number, number, number, number];
  curriculumSeed: string;
  curriculumCursor: number;
  currentLevelIndex: number;
  currentLevelWordIds: WordId[];
  activeLearningWordIds: WordId[]; // ungraduated introduced words
  reviewedOlderWordIds: WordId[];
  firstCompletedAt: string | null;
  words: Record<WordId, WordProgress>;
  orphanedProgress: Record<WordId, WordProgress>;
};
```

Fresh words start with `phase: "new"`, `difficulty: 5`, and null schedule
fields. There is no separate introduction encounter: the first appearance is
the test.

Keep `nextEligibleSpawn` per word even after graduation. It is the **hard
spacing floor**: after any spawn the word cannot reappear until two full
intervening words have spawned (`nextEligibleSpawn = lastSpawnOrdinal + 3`).
Both spawns and due points respect the floor, so a word can never return
earlier than promised, and quitting/restarting cannot bypass spacing.

Each level has a deterministic curriculum order and a rolling pool (default 20
active words, set by `levelSize`). On first play, introduce the first pool;
whenever a word graduates, introduce the next unseen word. Graduated words
leave the active pool but remain schedulable by `dueAt` during regular play.

## 3. Scheduler random streams

Use a small deterministic `xoshiro128**` implementation behind a `RandomSource`
interface. Seed a level from cryptographically random bytes on first creation,
then persist its four-word state.

Use independent streams for:

1. **scheduler RNG** — word lottery; persisted;
2. **choice RNG** — distractors/key positions, derived from session seed and enemy ID;
3. **visual RNG** — lanes/stars/effects, never used by learning.

A visual change must not alter which vocabulary appears next.

## 4. Hard spacing and due points

Ordinals count spawns within a level; `dueOrdinal` expresses short intra-session
steps in intervening words. For a word tested at ordinal `s` with step interval
`n`, `dueOrdinal = (s + 1) + n`, so the next test happens after exactly `n`
other spawns. The floor is always reserved at spawn time, and every step
interval is at least the floor, so due points can never precede eligibility.

Graduated words schedule by wall-clock time instead. On any graduated update,
`dueAt = now + max(1, round(stability))` days. Wall-clock due points are
authoritative across sessions: starting a new session or round can never
fast-forward a card toward its due date.

```ts
// constants (src/domain/learning/constants.ts)
HARD_MIN_INTERVENING_WORDS = 2
LEARNING_STEPS   = [3, 10, 30]   // intervening words per learning step
RELEARNING_STEPS = [2, 6, 18]    // steps after a lapse, before returning to review
EASY_INTERVAL_MULTIPLIER = 1.5
HARD_INTERVAL_MULTIPLIER = 0.5
```

## 5. Word selection: due state, urgency, and the 50/30/20 mix

Before each spawn, refill the active pool. Then bucket every eligible,
off-screen word by due state:

```text
due      = graduated words past dueAt + relearning words past dueOrdinal
learning = learning-phase words past dueOrdinal
new      = introduced words with no test yet
```

Choose the bucket by target shares **50% / 30% / 20%**, redistributing the
share of any empty bucket proportionally. Within a bucket, draw a
urgency-weighted lottery (overdue ordinals, days overdue, or age for new
words). An anti-starvation override picks the most eligible-age candidate
deterministically once one waits 150 or more spawns.

Invariants:

- Ineligible and not-yet-introduced words have zero probability.
- A word never appears twice on screen at once (spawn-time exclusion).
- Spacing is never violated to keep the arcade alive.

**When nothing is due**, the battlefield runs on ungraded practice instead of
dragging a cooling word back early: eligible words past their hard floor but
before their due point appear least-recently-seen first, and their outcomes
update counters only — never the schedule. If even practice is impossible
(everything in flight or under the floor), the scheduler returns
`noEligibleWord` and stops spawning with diagnostics.

## 6. Continuous grading

Every encounter is graded as one of four values, inferred from the outcome:

- **Again** — wrong pinyin, wrong meaning, landing, or pinyin autocomplete
  (the enemy records `autocompleted: true`, so a lucky meaning choice still
  grades as a lapse);
- **Hard** — correct, with slow pinyin: above `STRUGGLE_MS_PER_CHAR` (4,000 ms)
  per canonical pinyin character;
- **Good** — correct at normal speed;
- **Easy** — correct and fast: at or below `EASY_MS_PER_CHAR` (1,600 ms per char).

Latency is normalized by canonical pinyin length, so an answer just past a
boundary grades almost identically to one just before it — the old binary
8-second cliff is gone. Meaning response time is recorded for score and
statistics but never affects grading.

### Step phases

```text
NEW      + Good -> LEARNING step 1 (due in 3 words)
         + Good -> LEARNING step 2 (due in 10 words)
         + Good -> LEARNING step 3 (due in 30 words)
         + Good -> graduate to REVIEW (stability = 1 day)
Easy advances one step with the next interval stretched 1.5x.
Hard stays at the current step with the interval shortened 0.5x (floor 2).
Again restarts the phase's steps at step 1.
```

A word therefore needs at least four spaced successful recalls before it can
graduate; lucky double successes cannot master a word.

### Graduated (review) phase

Stability grows multiplicatively, damped by difficulty:

```text
Good: stability *= 2.5 - 0.15 * difficulty   difficulty -= 0.1
Hard: stability *= 1.2 - 0.05 * difficulty   (roughly flat — shorter next
                                              interval, never "less known")
Easy: stability *= 3.0 - 0.15 * difficulty   difficulty -= 0.3
Again: stability *= 0.25, difficulty += 1, -> relearning steps, lapses += 1
```

Stability is clamped to `[0.3, 365]` days and `dueAt = now + round(stability)`
days (at least 1). Completing all relearning steps returns the word to review
with its reduced stability.

### Ungraded practice

Practice encounters update counters, timing stats, and score, but never
touch phase, steps, due points, stability, difficulty, or lapses.

### Clocks

Response clocks use active simulation time:

- pinyin clock begins when the word first becomes the highlighted target;
- meaning clock begins after accepted pinyin;
- pause, settings, hidden tab, and feedback are excluded;
- changing game speed does not change measured milliseconds;
- audio load/play duration is excluded;
- reaching the ground does not end an encounter until the highlighted target has received the full pinyin recall window;
- after accepted pinyin, altitude cannot convert meaning-selection time into a recall failure.

Game settings influence points but not grading.

## 7. Completion transitions

After every word update:

```ts
masteredCount = count(words where phase === "review");
isLiveMastered = masteredCount === logicalWordCount;
```

If this becomes true and `firstCompletedAt` is null, set it and emit
`levelCompleted`. The celebration waits for a safe UI transition but saving
does not.

If lapses later lower `masteredCount`, emit `gradeMasteryRegressed` for UI
statistics; do not clear `firstCompletedAt`.

Deck selection should show both:

- live fraction, e.g. `286 / 300 mastered`;
- a permanent `CLEARED` badge if `firstCompletedAt` exists.

## 8. Mastery Review

The review deck is built from words whose regular-mode phase is `review`.
Each review card stores the same schedule shape (`phase: "review" |
"relearning"`, `stepIndex`, `dueOrdinal`, `dueAt`, `stability`, `difficulty`,
`lapses`) plus review-only stats (`recallScoreMsPerChar`, `struggles`).

- A newly mastered card enters due immediately (`dueAt = now`).
- Selection priority: relearning cards past `dueOrdinal`, then review cards
  past `dueAt`. There are **no graded fillers**: when neither queue has work
  the round ends. Unrelated mastered cards can never be pulled in and pushed
  back before their due date.
- `prepareReviewRound` syncs new mastered cards and drops stale repair-pool
  keys, but never advances scheduling state: wall-clock due points are
  authoritative between rounds.
- An `Again` in review lapses the card into intra-session relearning (2/6/18
  ordinals) exactly like a regular-mode lapse.

## 9. Decoupling mastery from battlefield pressure

The SRS decides **which** word appears; the player's recent performance decides
**how hard** the battlefield presses.

- Spawn delay: `baseInterval / performanceMultiplier` only. Mastery does not
  scale the timer.
- Enemy speed: displayed mastery nudges each word's speed within
  `0.90×..1.10×` (weak words descend slightly slower, as a readability aid).
- The performance multiplier (`0.7×..1.5×`, smoothed) reacts to thinking time
  against `RECALL_WINDOW_MS` (8,000 ms).

## 10. Authoritative save schema

One local profile is sufficient: `saves/default.json`.

```ts
type SaveFileV3 = {
  schemaVersion: 3;
  profileId: "default";
  revision: number;                // assigned by server
  savedAt: string;
  settings: {
    spawnIntervalMs: number;       // 1500..10000
    enemySpeedMultiplier: number;  // 0.65..1.50
    masterVolume: number;          // 0..1
    reducedMotion: boolean;
    levelSize: number;             // 5..100
  };
  levels: Partial<Record<DeckId, LevelProgress>>;
  review: ReviewProgress;
  lifetime: { ... };
};
```

Spaced-repetition behavior is intentionally **not** tunable from Settings;
the arcade exposes spawn rate, global speed, volume, reduced motion, and pool
size only. All SRS constants live in `src/domain/learning/constants.ts`.

All values have Zod bounds. Reject `NaN`, infinities, negative counters,
unknown deck IDs, unknown word IDs outside reconciliation, out-of-range
settings, and inconsistent spawn ordinals.

The file contains progress and scheduler state, not active sprites. Voluntary
session ending leaves current enemies unpenalized and starts a fresh
battlefield next time.

During development, incompatible save files are quarantined and recreated
rather than migrated.

## 11. Save API

Fastify exposes:

```text
GET  /api/health
GET  /api/saves/default
PUT  /api/saves/default
POST /api/saves/default/beacon    # best-effort pagehide only
```

`GET` returns either a validated snapshot or a first-run default based on
generated deck manifests.

`PUT` body:

```ts
{
  expectedRevision: number;
  snapshot: Omit<SaveFileV3, "revision" | "savedAt">;
}
```

The server:

1. validates request size and schema;
2. compares `expectedRevision` with disk revision;
3. returns `409` with current metadata on conflict;
4. assigns `revision + 1` and `savedAt`;
5. atomically writes;
6. returns the authoritative revision/timestamp.

Do not use last-writer-wins across tabs. A second tab sees a clear conflict
dialog and must reload current progress.

## 12. Atomic repository writes

For each accepted snapshot:

1. serialize stable, human-readable JSON with a final newline;
2. write `saves/default.json.tmp-<pid>-<nonce>` using an exclusive create;
3. flush and close the file;
4. optionally preserve the prior valid file as `default.json.bak`;
5. rename temporary file over `default.json` atomically;
6. fsync the directory where supported;
7. clean stale temp files on startup.

Only one in-process save queue writes at a time. If events arrive during a
write, coalesce them to the latest immutable snapshot and immediately perform
another write. Never run parallel writes.

## 13. Checkpoint policy

Checkpoint after anything that changes durable behavior:

- every enemy spawn (ordinal, RNG, and spacing changed);
- every resolved enemy (word progress/stats changed);
- settings apply/reset;
- level completion/regression;
- voluntary end session.

UI save states:

```text
SAVED -> SAVING -> SAVED
                 -> RETRYING
                 -> SAVE ERROR (End Session must offer retry/export)
```

A failed save does not stop play immediately, but the immutable latest
snapshot remains queued and the HUD shows a persistent warning. End Session
waits for it or offers JSON export; it must not falsely claim success.

`pagehide`/beacon is only best effort. Routine checkpoints are the reliability
mechanism.

## 14. Loading, corruption, and deck reconciliation

Only the current save schema (`3`) is accepted. During development,
incompatible save files are quarantined and recreated rather than migrated.

### Corrupt file

If parsing/validation fails:

1. rename it to `default.corrupt-<timestamp>.json` without overwriting;
2. try a valid `.bak`;
3. if backup succeeds, report recovery in UI;
4. otherwise return an explicit recovery response with options to start fresh
   or download the corrupt file;
5. never silently replace corruption with a blank save.

### Deck fingerprint changes

When generated deck fingerprint differs:

- match current logical word IDs to saved IDs;
- retain exact matches;
- initialize newly added words in phase `new`, eligible now;
- move removed IDs to `orphanedProgress`;
- clamp `nextEligibleSpawn` only if schema invariants require it;
- report retained/added/removed counts to the player;
- checkpoint migrated state before play.

Source GUIDs aid audits, but semantic logical IDs are the progress key.

## 15. Invariants to assert on every reducer result

```text
phase is one of new | learning | review | relearning
stepIndex is 0 outside step phases and within LEARNING/RELEARNING_STEPS inside
dueOrdinal is a nonnegative integer while learning/relearning, null otherwise
dueAt is a valid timestamp while review, null otherwise
stability is finite and >= 0; difficulty is 1..10; lapses is a nonnegative integer
nextEligibleSpawn >= 0 and integer
nextSpawnOrdinal >= 0 and integer
lastSpawnOrdinal is null or < nextSpawnOrdinal
if lastSpawnOrdinal != null, nextEligibleSpawn >= lastSpawnOrdinal + 1 + HARD_MIN_INTERVENING_WORDS
dueOrdinal, when present, >= nextEligibleSpawn
attempts == completeCorrect + wrongPinyin + wrongMeaning + landed
active learning IDs are known, unique, and ungraduated
curriculum cursor/order never reintroduces a word
all scheduler RNG words are uint32
live mastered count equals number of review-phase records
firstCompletedAt never changes from a timestamp back to null
settings remain in supported bounds/steps
```

Development builds may assert eagerly. Production server validation remains
mandatory before persistence.
