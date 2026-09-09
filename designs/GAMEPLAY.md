# Gameplay specification

> **Status update (battle-first rework):** Battle Mode is now the main game
> mode and the only launched gameplay flow. Spawns are live weighted draws
> from the vocabulary's mastery categories (see README §Battle Mode and
> `src/domain/battle`); the finite review base plan, recency tiers, repair
> obligations, and persisted scheduler RNG are gone. Writing/Learn and
> Re-Learn remain implemented internally but are disabled/hidden in the UI.
> Sections below that still describe recency pressure describe the retained
> mechanics in their new mastery-driven form.

## 1. Battlefield model

The battlefield is a pressure queue, not a one-enemy flashcard screen.

- Enemies spawn at normalized vertical progress `0` and land at `1`.
- More than one enemy may be descending at once; default settings produce roughly eight visible enemies once the queue stabilizes.
- Every enemy displays its own normalized Hanzi.
- Each Battle enemy has a word-specific speed derived from its **current mastery**: pressure `mastery / 100` maps linearly from `0.65×` (brand-new words, gentlest) to `1.50×` (mastered words, fastest). The global speed setting multiplies it uniformly.
- The global speed setting multiplies every word-specific speed; there is no random velocity.
- When a target is needed, choose the descending enemy with the shortest predicted time to ground, not the lowest altitude. An amber box/beam and the command panel identify it.
- Equal predicted arrival times are broken by lower `spawnOrdinal`.
- Once selected, the target stays locked until it is resolved or lands. A newly spawned word never steals the lock, even if its predicted arrival is earlier.
- There is no manual target switching in MVP.

Use normalized progress in the domain/simulation layer rather than canvas pixels:

```ts
wordSpeed = lerp(0.65, 1.50, word.mastery / 100)
progress += (deltaMs / BASE_TRAVEL_MS) * enemySpeedMultiplier * wordSpeed
arrivalTime = (1 - progress) / wordSpeed
```

`BASE_TRAVEL_MS = 24_000`. The shared global multiplier cancels when comparing arrival times. Phaser converts progress into a responsive world Y coordinate. This keeps gameplay timing stable across screen sizes.

### Spawn lanes

Use eight visual lanes across the arena. Lane selection is cosmetic and uses a separate visual PRNG. Avoid either of the last two lanes when alternatives exist to reduce overlapping sprites. Lanes do not change travel distance or targeting.

### Population ceiling

`MAX_ACTIVE_ENEMIES = 32` is a safety ceiling. If full, defer spawning; never remove an enemy merely to open a slot. The allowed settings should normally remain below this ceiling:

| Setting | Range | Step | Default |
|---|---:|---:|---:|
| Spawn interval | 1.5–5.0 seconds | 0.25 s | 3.0 s |
| Global speed multiplier | 0.65–1.50× | 0.05× | 1.00× |

At default values, one enemy lands every three seconds once the queue is full unless the player clears it. At 1.5-second spawning and 0.65× speed, about 25 enemies may coexist, still below the ceiling.

## 2. Target and encounter phases

Only the locked target can receive answer input. The command panel always repeats its Hanzi in accessible DOM.

```text
WAITING_FOR_TARGET
  predicted-soonest enemy exists
    -> PINYIN

PINYIN
  blank Enter                    -> ignore
  normalized answer accepted    -> play word audio -> MEANING
  non-empty answer rejected     -> MISS(reason=pinyin)
  target reaches ground          -> VANISH (silent, no outcome)
  answer clock reaches floorMs   -> SECOND CHANCE (whole field freezes)

MEANING
  R                              -> replay word audio
  non-ASDFHJKL key               -> ignore
  correct choice key             -> HIT
  wrong choice key               -> MISS(reason=meaning)
  target reaches ground          -> VANISH (silent, no outcome)
  answer clock reaches floorMs   -> SECOND CHANCE (whole field freezes)

SECOND CHANCE
  descent, spawning, and the answer clock are frozen; input stays live
  correct answer                 -> HIT with mastery held flat
  wrong answer                   -> MISS(reason=pinyin|meaning)

VANISH
  the word is removed with no reveal, no outcome, and no mastery change
  -> predicted-soonest remaining enemy becomes PINYIN target

HIT / MISS
  target is already resolved; late events are ignored
  HIT feedback is short and non-blocking
  wrong-answer feedback freezes descent and spawning until CONTINUE DEFENSE
  -> predicted-soonest remaining enemy becomes PINYIN target
```

A resolved target is removed from answer state immediately. Its explosion or breach sprite may remain temporarily as a visual effect, but cannot land or be answered again.

### Why a wrong answer resolves the enemy

MVP allows one learning outcome per enemy. Retrying the same enemy would complicate timing, allow repeated weight changes, and let one enemy block the whole pressure queue. A wrong answer therefore:

1. resets streak;
2. records one miss in the session stats and applies the Battle mastery penalty through the outcome endpoint;
3. reveals Hanzi, toned pinyin, and correct meaning;
4. starts a short breach animation;
5. removes the enemy from target eligibility;
6. checkpoints progress.

This can be replaced with a retry mode later without changing the scheduler contract.

## 3. Pinyin matching

The player is prompted with “TYPE PINYIN — NO TONE MARKS.” Matching is forgiving about formatting and tolerates one accidentally inserted letter, but not missing, substituted, transposed, or multiple extra letters.

Examples:

| Deck pinyin | Accepted examples | Rejected example |
|---|---|---|
| `xuéxí` | `xuexi`, `xue xi`, `xuéxí`, `xueexi` | `xuesi` |
| `nǚ’ér` | `nver`, `nuer`, `nü er`, `nu:er`, `nvver` | `ner` |
| `shéi/shuí` | `shei`, `shui`, `shuui` | `shi` |
| `hóng-lǜdēng` | `honglvdeng`, `hong lv deng`, `honglvvdeng` | `hongludeng` |

Canonicalization is specified in [`DATA_PIPELINE.md`](DATA_PIPELINE.md). It is used both during import and submission, after which the insertion tolerance is applied. A plain `u` is also accepted where the expected canonical form contains `v` (`ü`), since learners commonly omit the umlaut when typing without tone marks. Do not perform incremental red/green character checking; a submission is judged only on Enter. This avoids leaking the answer and supports natural editing.

Timing starts when the enemy first becomes the active target, not when it spawned. Pause, settings, second-chance, and hidden-tab time are excluded. The same clock keeps running across the pinyin AND meaning phases: it is the single answer clock that scores the encounter on the mastery speed curve and that opens second chance at `masteryCurve.floorMs`.

## 4. Meaning choices

After pinyin succeeds:

- play `AudioHanzi` immediately;
- show toned pinyin, part of speech/sense label when present, and eight English choices;
- map choices to `A S D F H J K L`;
- shuffle the correct position uniformly using the choice PRNG;
- allow keyboard, click, or touch selection;
- let **R** replay audio without score or mastery effects.

Distractor generation:

1. exclude the current logical word;
2. exclude every meaning whose reverse index includes the same normalized display Hanzi, preventing another valid sense of the prompt from appearing;
3. require eight unique normalized labels;
4. prefer the same normalized part of speech;
5. fill remaining slots from the selected deck's global meaning pool;
6. shuffle and assign keys.

Choices are generated from a PRNG stream separate from scheduling. UI or distractor changes must not alter the sequence of scheduled words or cooldown lengths.

## 5. Outcomes and mastery event

Each enemy produces exactly one of:

```ts
type EncounterOutcome =
  | { kind: "correct"; pinyinMs: number; meaningMs: number }
  | { kind: "wrongPinyin"; pinyinMs: number }
  | { kind: "wrongMeaning"; pinyinMs: number; meaningMs: number };
```

A word that reaches the ground produces NO outcome at all: it vanishes silently and the next target locks.

The encounter reducer marks an enemy resolved before emitting its outcome. Any late key or animation callback with that ID becomes a no-op. The learning module consumes one outcome and returns one updated word record.

Audio success/failure, animation completion, frame rate, and settings do not alter the outcome.

Battle persistence POSTs one `BattleOutcome` to the vocab outcome endpoint:

- `{ kind: "correct", answerMs }` — answered before the floor; the server reads the gain off the piecewise-linear `masteryCurve` at `answerMs`;
- `{ kind: "secondChance" }` — answered correctly after the field froze; applies `masteryCurve.secondChanceGain` (0 by default);
- `{ kind: "wrong" }` — a wrong pinyin or meaning at any time; applies `-masteryDelta`.

A vanished word POSTs nothing. The server clamps to 0..100, sets `time_mastered` once at 100, and refills the learning slot when a low word graduates; the client mirrors the same delta optimistically through `applyMasteryOutcome` and merges the authoritative rows asynchronously without blocking the animation.

## 6. Score and streak

There is no negative score and no game-over state.

### Streak

- A complete pinyin-plus-meaning success before the floor increments streak by one.
- Wrong pinyin, wrong meaning, or any second-chance answer sets streak to zero.
- A vanished word leaves the streak untouched.
- Pinyin success alone does not increment streak.
- Ending/pausing a session does not break streak; the current session streak is included in the voluntary summary but a new session starts at zero.

Show small celebrations at streaks 5, 10, 20, 30, and every additional 25. Celebrations must not block input.

### Points

Only complete correct encounters answered before the floor award points; a
second-chance answer scores exactly zero:

```ts
speedScore = clamp((12_000 - thinkingMs) / (12_000 - 2_500), 0, 1)
pressureFactor = clamp(Math.sqrt(3_000 / spawnIntervalMs), 0.75, 1.42)
difficultyFactor = clamp(pressureFactor * enemySpeedMultiplier, 0.50, 2.00)
streakFactor = 1 + Math.min(streakBeforeHit, 20) * 0.05
raw = (200 + 200 * speedScore) * streakFactor * difficultyFactor
points = Math.round(raw / 10) * 10
```

`thinkingMs = pinyinMs + meaningMs`, excluding pauses and feedback. Difficulty affects points but **not mastery**; accessibility-friendly settings must not prevent learning progress.

Track per-session:

- score;
- complete correct count;
- wrong-pinyin count;
- wrong-meaning count;
- second-chance answers;
- vanished words;
- best streak;
- words seen (unique and total);
- newly mastered and newly unmastered words.

Accuracy is `completeCorrect / resolvedEnemies`. Do not count blank or irrelevant input.

## 7. Spawning and pressure

The spawn clock runs while the battle is active, including pinyin, meaning, and non-blocking hit feedback. It freezes during second chance, during wrong-answer review, while paused/settings, while the page is hidden, and before deck/save loading completes.

After a word spawns, its current mastery sets the next interval. The multiplier interpolates linearly from `1.60` at pressure `0` (fresh words, gentlest), through `1.00` at pressure `0.5`, to `0.40` at pressure `1` (maximum pressure): `masteryInterval = baseInterval * lerp(1.60, 0.40, pressure)` where pressure is the spawned word's live `mastery / 100`. The existing performance multiplier then applies to that interval. The empty-battlefield 0.5-second refill remains the safety override.

Empty battlefield: after the board clears, the next word must be playable within two seconds (`EMPTY_FIELD_MAX_WRITE_MS`). The pre-write stroke animation compresses (`emptyFieldWriteSchedule`, speedup capped at 8x) instead of serializing its full natural-cadence lead. With enemies still active, pacing is unchanged.

When a timer is due:

1. if 32 enemies are active, keep one pending spawn and retry when a slot opens;
2. draw the next word LIVE: category weights from the Hill curve over the current pools, uniform within the selected category, never a word that is already active or preparing (`selectBattleSpawn` in `src/domain/battle/select.ts`);
3. assign enemy ID, ordinal, visual lane, and choice seed;
4. create the Phaser enemy.

Do not “catch up” with several immediate spawns after a pause, settings dialog, hidden tab, lag spike, or frame clamp. Set `nextSpawnAt = activeClock + currentInterval` after one spawn. This prevents bursts unrelated to player-selected pressure.

Simulation uses a fixed 60 Hz step with accumulated active time and a maximum of five catch-up steps per animation frame. Excess wall time is discarded after visibility/pause handling rather than teleporting enemies.

## 8. Settings behavior

Settings are reachable from deck selection and the pause overlay.

- Opening settings pauses enemy motion, spawn clock, answer clocks, and streak state.
- Base spawn slider displays both “every N seconds” and rounded enemies/minute; actual intervals also reflect the previous word's mastery and current performance pressure.
- Speed slider displays multiplier and a text label: `SLOW`, `STANDARD`, or `FAST`.
- “Apply” validates/clamps values, updates all active enemies uniformly, restarts the spawn interval from zero, saves settings, and returns to the prior screen.
- “Cancel” restores the original values.
- “Reset defaults” requires no confirmation because it does not erase learning progress.
- Targeting rule is displayed as fixed/read-only: “Closest to base is always highlighted.”

Settings persist in the player save but do not belong to an HSK level.

## 9. Vanishing, second chance, and feedback

### Vanishing

Any word — target or not — that reaches progress `>= 1` vanishes. Vanishing is
deliberately consequence-free: it

- removes the word from the field;
- emits NO outcome, reveals nothing, and leaves mastery untouched;
- leaves score and streak unchanged;
- records only a per-word `vanished` tally for the summary;
- immediately targets the remaining word predicted to land soonest.

Nothing ever parks at the landing line, so queued altitude drains instead of
piling up.

### Altitude relief

Every correct answer lifts each remaining word by a configured fraction of the
full descent: `relief.correct` (0.10) normally and `relief.secondChance` (0.05)
when the answer came in second chance. A wrong answer grants none. Relief is
unconditional — it no longer depends on the resolved word being in the danger
zone.

### Second chance

When the answer clock reaches `masteryCurve.floorMs` the encounter escalates to
second chance: descent, spawning, and the clock itself freeze while answer input
stays live, so the player may take as long as they like. A correct answer there
resolves the word and applies `masteryCurve.secondChanceGain` (0 by default) —
mastery is held exactly where it was — but scores no points and resets the
streak. A wrong answer costs `masteryDelta` like any other. The frozen duration
is handed back to the spawn clock on resolution so the untimed answer cannot
dump a burst of overdue spawns onto the field.

Because the freeze arrives before the ground can, a word that is being answered
effectively never vanishes; a word selected while already near the ground may.

### Correction panel

A wrong-answer breach is already logically resolved, so it cannot generate a
second outcome. Its correction panel reveals Hanzi, pinyin, and meaning; freezes
descent, spawning, and answer input; and remains until the player presses
**Continue Defense**. Review time is excluded from response timing, and the
spawn interval restarts on dismissal instead of catching up.

## 10. Session ending

**End Battle** is always available from pause — and it is the ONLY way a
session ends (battles are endless; there is no automatic completion). It:

1. stops the active clock and spawning;
2. does not mark currently descending enemies wrong;
3. opens the battle summary (score, accuracy, best streak, words served, and
   the most-reinforcement-needed ranking with mastery-category chips);
4. starts the next play session with a fresh battlefield and zero streak.

Every outcome is already persisted through the outcome endpoint at
resolution time, so ending a session has nothing left to flush; there is no
save beacon.
