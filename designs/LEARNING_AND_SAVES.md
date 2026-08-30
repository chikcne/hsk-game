# Learning scheduler, mastery, and local saves

## 1. Terminology

The user's “appearance threshold” is represented as an integer `appearanceWeight`:

- minimum `1` = mastered and least frequent;
- initial `70` = new/unpracticed;
- maximum `100` = highest reinforcement priority.

A level's **live mastery** is complete only when every logical word is at `1`. A permanent `firstCompletedAt` milestone records that the level was beaten at least once. If a mastered fallback word is later missed, its weight rises and live mastery regresses, but the earned cleared milestone remains.

This is intentionally Anki-like rather than an attempt to reuse Anki's original card scheduling. Source cards and review history are not imported.

## 2. Progress records

```ts
type WordProgress = {
  appearanceWeight: number;       // integer 1..100
  attempts: number;
  completeCorrect: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  totalThinkingMs: number;
  fastestCorrectMs: number | null;
  lastOutcome: EncounterOutcomeKind | null;
  lastSeenAt: string | null;       // ISO timestamp, display/statistics only
  introducedAtOrdinal: number | null;
  lastSpawnOrdinal: number | null;
  nextEligibleSpawn: number;       // absolute ordinal, enforces cooldown
  reinforcementRemaining: 0 | 1 | 2 | 3;
};

type LevelProgress = {
  deckId: DeckId;
  deckFingerprint: string;
  nextSpawnOrdinal: number;
  schedulerRng: [number, number, number, number];
  curriculumSeed: string;
  curriculumCursor: number;
  activeLearningWordIds: WordId[]; // normally 30, may temporarily expand after relapse
  firstCompletedAt: string | null;
  words: Record<WordId, WordProgress>;
  orphanedProgress: Record<WordId, WordProgress>;
};
```

Fresh words start with:

```ts
{
  appearanceWeight: 70,
  attempts: 0,
  completeCorrect: 0,
  wrongPinyin: 0,
  wrongMeaning: 0,
  landed: 0,
  totalThinkingMs: 0,
  fastestCorrectMs: null,
  lastOutcome: null,
  lastSeenAt: null,
  introducedAtOrdinal: null,
  lastSpawnOrdinal: null,
  nextEligibleSpawn: 0,
  reinforcementRemaining: 0
}
```

Keep `nextEligibleSpawn` per word even when it is mastered. That is what prevents a player from quitting and restarting to bypass repetition spacing.

Do not put all 1,800 HSK 6 words into one flat lottery: a missed word would still take too long to return. Each level has a deterministic curriculum order and normally **30 active learning words**. On first play, introduce the first 30; whenever one reaches weight `1`, introduce the next unseen word. This gives errors meaningful near-term priority while still progressing through every source word.

## 3. Scheduler random streams

Use a small deterministic `xoshiro128**` implementation behind a `RandomSource` interface. Seed a level from cryptographically random bytes on first creation, then persist its four-word state.

Use independent streams for:

1. **scheduler RNG** — word lottery and cooldown values; persisted;
2. **choice RNG** — distractors/key positions, derived from session seed and enemy ID;
3. **visual RNG** — lanes/stars/effects, never used by learning.

A visual change must not alter which vocabulary appears next.

## 4. Gaussian cooldown

After every spawn, draw the required number of **other enemy spawns** before that word can appear again.

```ts
function drawCooldown(rng: RandomSource): number {
  while (true) {
    const u1 = nonZeroUnit(rng);
    const u2 = rng.nextUnit();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const candidate = Math.round(17.5 + 3.25 * z);
    if (candidate >= 10 && candidate <= 25) return candidate;
  }
}
```

This is a truncated Gaussian, not a clamped Gaussian. Rejection avoids artificial piles at 10 and 25.

If a word is spawned at ordinal `s` with cooldown `c`:

```ts
word.lastSpawnOrdinal = s;
word.nextEligibleSpawn = s + c + 1;
level.nextSpawnOrdinal = s + 1;
```

For `c = 10`, ordinals `s+1` through `s+10` must be other words, and the original word first becomes eligible at `s+11`.

Arcade mode requires at least 26 logical words. The six HSK sources have at least 200. A 30-word active curriculum guarantees a candidate during initial learning: at most 25 distinct words can be cooling from the preceding 25 spawns. Near level completion, the full mastered set is the fallback reserve. If corruption still produces no eligible candidate, return `noEligibleWord` and stop spawning with diagnostics; never violate cooldown to recover.

## 5. Curriculum and word selection

Create curriculum order by sorting all word IDs on a versioned hash of `(curriculumSeed, deckFingerprint, wordId)`. This is a deterministic seeded shuffle without storing a second 1,800-ID array. `curriculumCursor` points after the last introduced word.

Before scheduling, refill `activeLearningWordIds` to 30 with unseen words, setting each `introducedAtOrdinal` to the current `nextSpawnOrdinal`. Remove an active word when it reaches weight `1`. If a mastered fallback word is missed, add it back to active learning without evicting an existing weak word; temporary expansion above 30 is intentional.

At each spawn ordinal `s`, construct eligible tiers:

```text
repair = eligible active words where reinforcementRemaining > 0
learning = eligible active words where appearanceWeight > 1
fallback = eligible mastered words where appearanceWeight == 1
pool = first non-empty tier: repair, then learning, then fallback
```

This implements both “wrong words much more frequently” and “spawn mastered words if you must”:

- a miss creates three repair-priority opportunities, each still separated by its hard cooldown;
- ordinary active learning words do not compete with the entire 1,800-word deck;
- when repair/learning words are cooling, eligible mastered words fill the required 10–25 intervening spawns;
- after all words are mastered, play continues using fallback words.

Choose within the selected tier by weighted lottery:

```ts
ageOrigin = lastSpawnOrdinal ?? introducedAtOrdinal ?? s;
eligibleAge = Math.max(0, s - ageOrigin - 25);
ageBoost = 1 + Math.min(1.5, eligibleAge / 100);
effectiveWeight = appearanceWeight * ageBoost;
```

Use one scheduler RNG draw over cumulative effective weights. If any candidate has `eligibleAge >= 150`, use an anti-starvation override: choose greatest eligible age, then greatest weight, then stable word ID. This supplies a deterministic upper bound instead of relying forever on lottery luck.

### Selection invariants

- Ineligible and not-yet-introduced words have zero probability.
- A non-empty repair tier excludes ordinary learning and fallback candidates.
- A non-empty learning tier excludes mastered fallback candidates.
- Higher weight means higher probability among otherwise equal candidates.
- A candidate eligible but unselected for 150 spawns is selected by the anti-starvation override.
- Any chosen word receives a new cooldown before the next scheduler call.
- The same word ID cannot occupy two simultaneous enemies because its cooldown is already set when spawned.

## 6. Updating appearance weight

An enemy updates its word exactly once.

### Correct pinyin and meaning

```ts
thinkingMs = pinyinMs + meaningMs;
speedScore = clamp((12_000 - thinkingMs) / 9_500, 0, 1);
decrease = 4 + Math.round(12 * speedScore); // 4..16
newWeight = Math.max(1, oldWeight - decrease);
reinforcementRemaining = Math.max(0, reinforcementRemaining - 1);
if (newWeight === 1) reinforcementRemaining = 0;
```

- 2.5 seconds or faster: decrease by 16.
- 7.25 seconds: decrease by about 10.
- 12 seconds or slower: decrease by 4.

This meets the requirement that faster retrieval lowers future frequency more strongly while still allowing slow correct answers to progress.

### Misses

```ts
wrongPinyin: newWeight = Math.min(100, oldWeight + 30)
wrongMeaning: newWeight = Math.min(100, oldWeight + 30)
landed: newWeight = Math.min(100, oldWeight + 35)
reinforcementRemaining = 3
```

A single miss therefore reverses roughly two fast successes and as many as seven slow successes, then promotes the word into the repair tier for up to three clean recalls. It becomes much more frequent once its cooldown expires without ever breaking the required spacing. Landing is slightly stronger because no complete retrieval occurred.

Correct at weight `1` remains `1`. A miss at weight `1` moves it to `31` or `36`, making it unmastered again.

### Clocks

Response clocks use active simulation time:

- pinyin clock begins when the word first becomes the highlighted target;
- meaning clock begins after accepted pinyin;
- pause, settings, hidden tab, and feedback are excluded;
- changing game speed does not change measured milliseconds;
- audio load/play duration is excluded;
- reaching the ground does not end an encounter until the highlighted target has received the full pinyin recall window;
- after accepted pinyin, altitude cannot convert meaning-selection time into a recall failure.

Game settings influence points but not mastery formulas.

## 7. Completion transitions

After every word update:

```ts
masteredCount = count(words where appearanceWeight === 1);
isLiveMastered = masteredCount === logicalWordCount;
```

If this becomes true and `firstCompletedAt` is null, set it and emit `levelCompleted`. The celebration waits for a safe UI transition but saving does not.

If a miss later lowers `masteredCount`, emit `levelMasteryRegressed` for UI statistics; do not clear `firstCompletedAt`.

Deck selection should show both:

- live fraction, e.g. `286 / 300 mastered`;
- a permanent `CLEARED` badge if `firstCompletedAt` exists.

## 8. Authoritative save schema

One local profile is sufficient for MVP: `saves/default.json`.

```ts
type SaveFileV1 = {
  schemaVersion: 1;
  profileId: "default";
  revision: number;                // assigned by server
  savedAt: string;
  settings: {
    spawnIntervalMs: number;       // 1500..5000
    enemySpeedMultiplier: number;  // 0.65..1.50
    masterVolume: number;          // 0..1
    reducedMotion: boolean;
  };
  levels: Partial<Record<DeckId, LevelProgress>>;
  lifetime: {
    score: number;
    resolvedEnemies: number;
    completeCorrect: number;
    wrongPinyin: number;
    wrongMeaning: number;
    landed: number;
    bestStreak: number;
    totalThinkingMs: number;
  };
};
```

All values have Zod bounds. Reject `NaN`, infinities, negative counters, unknown deck IDs, unknown word IDs outside migration, out-of-range weights/cooldowns/settings, and inconsistent spawn ordinals.

The file contains progress and scheduler state, not active sprites. Voluntary session ending leaves current enemies unpenalized and starts a fresh battlefield next time.

## 9. Save API

Fastify, bound to `100.65.64.80`, exposes:

```text
GET  /api/health
GET  /api/saves/default
PUT  /api/saves/default
POST /api/saves/default/beacon    # best-effort pagehide only
```

`GET` returns either a validated snapshot or a first-run default based on generated deck manifests.

`PUT` body:

```ts
{
  expectedRevision: number;
  snapshot: Omit<SaveFileV1, "revision" | "savedAt">;
}
```

The server:

1. validates request size (maximum 2 MiB) and schema;
2. compares `expectedRevision` with disk revision;
3. returns `409` with current metadata on conflict;
4. assigns `revision + 1` and `savedAt`;
5. atomically writes;
6. returns the authoritative revision/timestamp.

Do not use last-writer-wins across tabs. A second tab sees a clear conflict dialog and must reload current progress.

Profile/path parameters are not accepted in MVP, eliminating path traversal. If profiles are added, IDs must match a strict allowlist and resolved paths must remain under `saves/`.

## 10. Atomic repository writes

For each accepted snapshot:

1. serialize stable, human-readable JSON with a final newline;
2. write `saves/default.json.tmp-<pid>-<nonce>` using an exclusive create;
3. flush and close the file;
4. optionally preserve the prior valid file as `default.json.bak`;
5. rename temporary file over `default.json` atomically;
6. fsync the directory where supported;
7. clean stale temp files on startup.

Only one in-process save queue writes at a time. If events arrive during a write, coalesce them to the latest immutable snapshot and immediately perform another write. Never run parallel writes.

## 11. Checkpoint policy

Checkpoint after anything that changes durable behavior:

- every enemy spawn (ordinal, RNG, and cooldown changed);
- every resolved enemy (word progress/stats changed);
- settings apply/reset;
- level completion/regression;
- voluntary end session.

At the fastest allowed spawn rate this is at most one spawn checkpoint every 1.5 seconds plus answer outcomes, acceptable for a local JSON file. Coalescing avoids redundant writes when spawn and answer occur together.

UI save states:

```text
SAVED -> SAVING -> SAVED
                 -> RETRYING
                 -> SAVE ERROR (End Session must offer retry/export)
```

A failed save does not stop play immediately, but the immutable latest snapshot remains queued and the HUD shows a persistent warning. End Session waits for it or offers JSON export; it must not falsely claim success.

`pagehide`/beacon is only best effort. Routine checkpoints are the reliability mechanism.

## 12. Loading, corruption, and deck reconciliation

Only the current save schema is accepted. During development, incompatible save files should be deleted and recreated rather than migrated.

### Corrupt file

If parsing/validation fails:

1. rename it to `default.corrupt-<timestamp>.json` without overwriting;
2. try a valid `.bak`;
3. if backup succeeds, report recovery in UI;
4. otherwise return an explicit recovery response with options to start fresh or download the corrupt file;
5. never silently replace corruption with a blank save.

### Deck fingerprint changes

When generated deck fingerprint differs:

- match current logical word IDs to saved IDs;
- retain exact matches;
- initialize newly added words at weight `70` and eligible now;
- move removed IDs to `orphanedProgress`;
- clamp `nextEligibleSpawn` only if schema invariants require it;
- report retained/added/removed counts to the player;
- checkpoint migrated state before play.

Source GUIDs aid audits, but semantic logical IDs are the progress key.

## 13. Invariants to assert on every reducer result

```text
1 <= appearanceWeight <= 100 and integer
nextEligibleSpawn >= 0 and integer
nextSpawnOrdinal >= 0 and integer
lastSpawnOrdinal is null or < nextSpawnOrdinal
if lastSpawnOrdinal != null, nextEligibleSpawn >= lastSpawnOrdinal + 11
reinforcementRemaining is integer 0..3 and is 0 whenever weight == 1
active learning IDs are known, unique, and unmastered
curriculum cursor/order never reintroduces a word
all scheduler RNG words are uint32
attempts == completeCorrect + wrongPinyin + wrongMeaning + landed
live mastered count equals number of weight-1 records
firstCompletedAt never changes from a timestamp back to null
settings remain in supported bounds/steps
```

Development builds may assert eagerly. Production server validation remains mandatory before persistence.
