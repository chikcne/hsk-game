# Gameplay specification

## 1. Battlefield model

The battlefield is a pressure queue, not a one-enemy flashcard screen.

- Enemies spawn at normalized vertical progress `0` and land at `1`.
- More than one enemy may be descending at once; default settings produce roughly eight visible enemies once the queue stabilizes.
- Every enemy displays its own normalized Hanzi.
- Each enemy has a word-specific speed derived from mastery: mastery `1` uses `0.65×` and mastery `100` uses `1.50×`, linearly interpolated between them.
- The global speed setting multiplies every word-specific speed; there is no random velocity.
- When a target is needed, choose the descending enemy with the shortest predicted time to ground, not the lowest altitude. An amber box/beam and the command panel identify it.
- Equal predicted arrival times are broken by lower `spawnOrdinal`.
- Once selected, the target stays locked until it is resolved or lands. A newly spawned alien never steals the lock, even if its predicted arrival is earlier.
- There is no manual target switching in MVP.

Use normalized progress in the domain/simulation layer rather than canvas pixels:

```ts
mastery = 101 - appearanceWeight
wordSpeed = lerp(0.65, 1.50, (mastery - 1) / 99)
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
  target at ground before recall window expires -> wait at ground
  target at ground after recall window expires  -> MISS(reason=landing)

MEANING
  R                              -> replay word audio
  non-ASDFHJKL key               -> ignore
  correct choice key             -> HIT
  wrong choice key               -> MISS(reason=meaning)
  target reaches ground          -> wait for meaning answer

HIT / MISS
  target is already resolved; late events are ignored
  HIT and natural-landing feedback are short and non-blocking
  wrong-answer feedback freezes descent and spawning until CONTINUE DEFENSE
  -> predicted-soonest remaining enemy becomes PINYIN target
```

A resolved target is removed from answer state immediately. Its explosion or breach sprite may remain temporarily as a visual effect, but cannot land or be answered again.

### Why a wrong answer resolves the enemy

MVP allows one learning outcome per enemy. Retrying the same enemy would complicate timing, allow repeated weight changes, and let one enemy block the whole pressure queue. A wrong answer therefore:

1. resets streak;
2. records one miss, raises appearance weight, and gives that word three repair-priority recalls (still subject to cooldown);
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
| `nǚ’ér` | `nver`, `nü er`, `nu:er`, `nvver` | `nuer` |
| `shéi/shuí` | `shei`, `shui`, `shuui` | `shi` |
| `hóng-lǜdēng` | `honglvdeng`, `hong lv deng`, `honglvvdeng` | `hongludeng` |

Canonicalization is specified in [`DATA_PIPELINE.md`](DATA_PIPELINE.md). It is used both during import and submission, after which the insertion tolerance is applied. Do not perform incremental red/green character checking; a submission is judged only on Enter. This avoids leaking the answer and supports natural editing.

Timing starts when the enemy first becomes the active target, not when it spawned. Pause, settings, and hidden-tab time are excluded. An enemy that reaches the ground before selection waits there, and a newly selected enemy always receives the full configured recall window regardless of altitude. Once pinyin is accepted, altitude cannot turn meaning-selection time into a recall failure.

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
  | { kind: "wrongMeaning"; pinyinMs: number; meaningMs: number }
  | { kind: "landed"; activeThinkingMs: number | null };
```

The encounter reducer marks an enemy resolved before emitting its outcome. Any late key, animation, or landing callback with that ID becomes a no-op. The learning module consumes one outcome and returns one updated word record.

Audio success/failure, animation completion, frame rate, and settings do not alter the outcome.

## 6. Score and streak

There is no negative score and no game-over state.

### Streak

- A complete pinyin-plus-meaning success increments streak by one.
- Wrong pinyin, wrong meaning, or landing sets streak to zero.
- Pinyin success alone does not increment streak.
- Ending/pausing a session does not break streak; the current session streak is included in the voluntary summary but a new session starts at zero.

Show small celebrations at streaks 5, 10, 20, 30, and every additional 25. Celebrations must not block input.

### Points

Only complete correct encounters award points:

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
- natural landings;
- best streak;
- words seen (unique and total);
- newly mastered and newly unmastered words.

Accuracy is `completeCorrect / resolvedEnemies`. Do not count blank or irrelevant input.

## 7. Spawning and pressure

The spawn clock runs while the battle is active, including pinyin, meaning, and non-blocking hit/landing feedback. It freezes during wrong-answer review, while paused/settings, while the page is hidden, and before deck/save loading completes.

When a timer is due:

1. if 32 enemies are active, keep one pending spawn and retry when a slot opens;
2. let the scheduler refill its deterministic 30-word curriculum, then choose from repair, active-learning, or mastered-fallback tier;
3. assign enemy ID, ordinal, visual lane, and choice seed;
4. set word cooldown from the scheduler;
5. checkpoint scheduler state;
6. create the Phaser enemy.

Do not “catch up” with several immediate spawns after a pause, settings dialog, hidden tab, lag spike, or frame clamp. Set `nextSpawnAt = activeClock + currentInterval` after one spawn. This prevents bursts unrelated to player-selected pressure.

Simulation uses a fixed 60 Hz step with accumulated active time and a maximum of five catch-up steps per animation frame. Excess wall time is discarded after visibility/pause handling rather than teleporting enemies.

## 8. Settings behavior

Settings are reachable from deck selection and the pause overlay.

- Opening settings pauses enemy motion, spawn clock, answer clocks, and streak state.
- Spawn slider displays both “every N seconds” and rounded enemies/minute.
- Speed slider displays multiplier and a text label: `SLOW`, `STANDARD`, or `FAST`.
- “Apply” validates/clamps values, updates all active enemies uniformly, restarts the spawn interval from zero, saves settings, and returns to the prior screen.
- “Cancel” restores the original values.
- “Reset defaults” requires no confirmation because it does not erase learning progress.
- Targeting rule is displayed as fixed/read-only: “Closest to base is always highlighted.”

Settings persist in the player save but do not belong to an HSK level.

## 9. Landing and feedback

A natural landing occurs only when the selected target is at progress `>= 1`, remains in the pinyin phase, and its active recall window has expired. Reaching the ground before selection or before that deadline clamps the enemy at ground level instead. A landing:

- removes the enemy;
- emits one `landed` outcome;
- resets streak;
- flashes the impacted base lane and displays the correction;
- leaves score unchanged;
- checkpoints immediately;
- targets the remaining enemy predicted to land soonest.

Natural-landing notices do not block the simulation. The next enemy becomes selected immediately, but even if it is already at ground level its own recall window starts at selection, so landings cannot cascade from queued altitude alone.

A wrong-answer breach is already logically resolved, so it cannot generate a second landing outcome. Its correction panel reveals Hanzi, pinyin, and meaning; freezes descent, spawning, and answer input; and remains until the player presses **Continue Defense**. Review time is excluded from response timing, and the spawn interval restarts on dismissal instead of catching up.

## 10. Session ending

**End Session** is always available from pause. It:

1. stops the active clock and spawning;
2. does not mark currently descending enemies wrong;
3. flushes the latest scheduler/save snapshot;
4. waits for acknowledgement or shows a retry/export warning;
5. opens the defense report;
6. starts the next play session with a fresh battlefield and zero streak, while retained cooldown ordinals prevent restart farming.

Closing the tab is less reliable than End Session, so the app already checkpoints every spawn/outcome/settings change. `pagehide` sends a final beacon as best effort, not as the primary save mechanism.
