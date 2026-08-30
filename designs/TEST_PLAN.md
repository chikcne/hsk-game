# Verification and test plan

## 1. Test layers and commands

```text
npm run typecheck          strict TypeScript for client/server/tools/tests
npm run test:unit          Vitest pure domain/import normalizer tests
npm run test:integration   importer fixture + save API + coordinator tests
npm run test:e2e           Playwright Chromium keyboard/touch flows
npm run test:visual        stable screenshot comparisons
npm run test               typecheck + unit + integration
npm run import:decks       real-source audit, run separately because it is large
```

Use fake/active clocks and seeded random sources. Domain tests must not wait on wall time or rely on Phaser rendering.

Recommended extra test dependency: `fast-check` for property/state-machine tests.

## 2. Importer tests

### Synthetic fixture

Generate or commit a tiny legal APKG fixture containing at least 30 logical words so cooldown and distractor preconditions are valid. It should include:

- accented pinyin and `ü`;
- `/` pronunciation alternatives;
- compatibility-form Hanzi;
- source HTML/entity fields;
- parenthetical and numeric sense labels;
- one exact semantic duplicate;
- one same-Hanzi distinct sense;
- one explicit override;
- resolvable word audio;
- unused image and sentence audio proving selective extraction.

The fixture must be created from original test content, not copied copyrighted deck media.

### Unit cases

- split `flds` into exactly ten fields;
- NFKC converts `⼋` → `八`, `⽩⾊` → `白色`, `爱⼈` → `爱人`;
- terminal ` (classifier)`, ` (verb)`, and sense digits are extracted without removing real Hanzi;
- explicit `劳verb` override becomes `劳动` and is reported;
- HTML entities decode and tags never reach runtime labels;
- long meanings remain untruncated;
- stable IDs remain identical across source row reorder;
- exact duplicate merges source GUIDs/audio deterministically;
- same Hanzi with different toned pinyin or meaning remains distinct;
- unsafe archive/media paths are rejected;
- missing/malformed audio blocks import;
- unused image/sentence audio is not emitted;
- output is byte-identical on two runs;
- a failed import leaves previous generated output intact.

### Real deck audit

Verify current source counts and expected logical counts:

```text
HSK1 300 -> 300
HSK2 200 -> 200
HSK3 500 -> 500
HSK4 1000 -> 1000
HSK5 1601 -> 1600
HSK6 1800 -> 1798
```

For every emitted word assert:

- valid unique ID;
- non-empty display Hanzi/pinyin/meaning;
- at least one accepted pinyin;
- local audio exists and hashes correctly;
- meaning reverse index contains the word;
- seven safe unique distractors exist after same-Hanzi exclusion.

Verify package hashes against `decks/SHA256SUMS` and all 5,401 source word-audio references resolve.

## 3. Pinyin tests

Table-driven canonicalization:

| Input | Expected |
|---|---|
| `xuéxí` | `xuexi` |
| ` Xue Xi ` | `xuexi` |
| `nǚ’ér` | `nver` |
| `nü er` | `nver` |
| `nu:er` | `nver` |
| `nuer` | `nuer` (must not accidentally equal `nver`) |
| `hóng-lǜdēng` | `honglvdeng` |
| `kě’ài` | `keai` |
| composed/decomposed Unicode equivalents | identical result |

Alternative source `shéi/shuí` emits `shei` and `shui`. Empty/punctuation-only input canonicalizes empty and is ignored by the encounter reducer.

Property: canonicalization is idempotent for canonical output.

## 4. Cooldown and scheduler tests

### Exact cooldown examples

For a word spawned at ordinal 100:

- cooldown 10 → ineligible at 101–110, eligible at 111;
- cooldown 25 → ineligible at 101–125, eligible at 126.

Run a 100,000-spawn seeded simulation over 200 words and assert no repeated word has fewer than ten intervening spawns. Persist/load midway and assert the resulting second half exactly matches an uninterrupted run.

### Gaussian distribution

With fixed seed and 100,000 draws:

- every integer is in `[10, 25]`;
- all values 10–25 occur;
- sample mean lies in a broad non-flaky band around 17.5 (for example 17.35–17.65);
- central bins occur more often than endpoint bins;
- no clamping pile appears at 10 or 25.

Test rejection behavior with a scripted RNG that first produces out-of-range values and then a valid value.

### Tier and weighting

- deterministic curriculum introduces exactly 30 words initially and never introduces one twice;
- mastering an active word removes it and introduces the next unseen word;
- a mastered fallback lapse rejoins active learning without evicting another weak word;
- eligible repair words exclude ordinary learning and mastered candidates;
- eligible ordinary active words exclude mastered candidates;
- when all active words are cooling down, mastered eligible words fill spawns;
- after all words master, mastered words still spawn;
- not-yet-introduced and ineligible weight-100 words have zero selections;
- among equal-age candidates, weight 100 wins statistically more than weight 10 using broad deterministic bounds;
- age boost increases a neglected word's effective weight but never exceeds configured cap;
- anti-starvation deterministically selects a candidate at 150 eligible spawns;
- selected word gets cooldown before a second scheduler call;
- official minimum deck size never produces `noEligibleWord` in long simulation.

Property test random save states satisfying invariants, then ensure selected IDs are always from the calculated eligible tier.

## 5. Mastery tests

Boundary values:

- correct in ≤2,500 ms decreases weight by 16;
- correct in 12,000 ms or more decreases by 4;
- midpoint yields expected intermediate decrease;
- weight never falls below 1;
- wrong pinyin/meaning adds 30, cap 100, and sets three repairs;
- landing adds 35, cap 100, and sets three repairs;
- each complete correct decrements repair count; reaching weight 1 clears it;
- mastered miss moves 1 → 31/36 and returns the word to active repair;
- audio failure does not change outcome;
- pause/hidden time is excluded;
- speed/spawn settings do not change mastery for same response milliseconds.

Counter invariant after arbitrary outcome sequence:

```text
attempts = completeCorrect + wrongPinyin + wrongMeaning + landed
```

Completion:

- final word reaching 1 sets `firstCompletedAt` once;
- another correct does not change timestamp;
- later miss regresses live mastery but preserves timestamp;
- migrated added word makes live mastery incomplete while preserving prior clear milestone.

## 6. Encounter reducer tests

Cover every state/event pair, especially ignored events.

- no target + pinyin input → no-op;
- blank Enter in pinyin → no-op;
- accepted pinyin → meaning phase plus one audio command;
- rejected pinyin → one miss/breach/save command;
- non-choice key in meaning → no-op;
- R → replay command only;
- correct key → one hit/score/mastery/save command;
- wrong key → one miss/breach/save command;
- key repeat after resolution → no-op;
- late Phaser landing callback after wrong breach → no-op;
- duplicate landing callback → one outcome;
- target landing during meaning → one landing, no answer accepted later.

### Deadline race

Define and test ordering: input events captured before a fixed simulation step are reduced before that step advances movement. Therefore a valid submission queued just before progress crosses `1` wins; once a landing outcome has been reduced, later input loses. Tests use explicit sequence numbers, not real event-loop timing.

## 7. Multi-enemy simulation tests

- default spawn settings produce multiple visible enemies;
- all descending progress deltas are equal for equal starting progress;
- closest progress is active;
- equal progress chooses lower spawn ordinal;
- newer same-speed enemy never overtakes older enemy;
- hit/removal selects the next closest immediately;
- natural landing selects the next closest immediately;
- changing global speed applies identical multiplier to every active enemy and preserves ordering;
- changing spawn interval creates no immediate catch-up burst;
- pause/settings/hidden page freezes progress, spawn clock, and answer clocks;
- one spawn occurs after lag clamp, not several catch-up spawns;
- maximum 32 defers a spawn without discarding an existing enemy;
- ending session does not mark active enemies missed.

Run simulation independent of canvas dimensions and assert the same outcomes at desktop/mobile sizes.

## 8. Choice generation tests

For every real runtime word across all six decks, generate choices over several seeds and assert:

- exactly eight keys `A S D F H J K L`;
- correct meaning appears exactly once;
- labels are unique by normalized key;
- no distractor reverse-maps to current Hanzi;
- correct key position varies across seeds;
- generation is deterministic for same enemy/choice seed;
- scheduler RNG state is unchanged;
- full source label is preserved even when long.

When same-POS pool has fewer than seven candidates, verify global fallback fills safely.

## 9. Scoring/streak tests

- full correct increments streak once and awards rounded nonnegative points;
- pinyin success alone awards nothing;
- all miss kinds reset streak and award zero;
- blank/irrelevant keys do not reset;
- streak factor caps at 20 prior hits;
- difficulty factor clamps to 0.5–2.0;
- easier settings produce lower points than harder settings for same response;
- settings do not alter mastery delta;
- score never becomes `NaN`, negative, or non-integer;
- session summary counters and accuracy match resolved outcomes.

## 10. Save repository/API tests

Use a temporary directory, never real `saves/`.

### Validation and API

- first GET returns valid default;
- valid PUT increments server-owned revision;
- stale expected revision returns 409 and does not write;
- payload >2 MiB returns 413;
- malformed JSON/schema/out-of-range values return 400;
- unknown profile/path cannot be requested;
- server binds loopback by default;
- two concurrent PUTs serialize and only one wins expected revision.

### Atomicity

Inject failures after temp open, partial write, flush, and before rename. Original valid save remains readable. Temp files are cleaned on startup. Successful rename leaves complete JSON with final newline.

### Recovery/reconciliation

- malformed main + valid backup recovers backup and reports it;
- malformed main without backup is quarantined, not overwritten;
- deck fingerprint migration retains matching IDs, initializes new IDs, orphans removed IDs, and reports counts;
- load-save-load round trip preserves scheduler RNG/cooldowns exactly.

## 11. Client/server integration tests

With a fake game renderer:

- deck select loads runtime deck plus save level;
- spawn event immediately queues checkpoint;
- outcome arriving during save coalesces to latest follow-up snapshot;
- HUD transitions SAVING → SAVED only after server response;
- transient failure retries latest snapshot;
- End Session waits for flush;
- permanent failure offers retry/export and never says saved;
- refresh loads same mastery/settings/cooldowns/revision;
- second-tab conflict presents reload path rather than overwriting.

## 12. Playwright end-to-end journeys

Use a tiny generated test deck and deterministic clock.

1. **Keyboard success**: select HSK, see several enemies, confirm lowest highlighted, type pinyin, hear mocked audio call, press correct letter, score/streak increase, save file updates.
2. **Wrong pinyin**: wrong non-empty Enter shows correction, resets streak, breaches once, raises weight, selects next enemy.
3. **Wrong meaning**: correct pinyin then wrong letter shows chosen/correct labels and one miss.
4. **Natural landing**: advance clock, verify no game over and next target highlight.
5. **Cooldown across restart**: spawn a word, end, reload, verify it does not reappear before stored eligibility.
6. **Settings**: pause, adjust rate/speed, assert scene frozen, apply, assert all enemies same new speed and no burst, reload and verify persistence.
7. **End session**: end with enemies active, verify they are not misses, report waits for save, resume fresh arena with progress retained.
8. **Completion/regression**: drive all fixture words to 1, see cleared milestone, miss fallback word, retain badge but show live regression.
9. **Mobile touch**: 360×640 emulation, pinyin input visible above keyboard viewport, all eight meaning choices tappable.
10. **Audio failure**: reject play promise, answer still succeeds and visible warning appears.

## 13. Accessibility checks

Automate axe checks on every screen/dialog plus manual keyboard review.

- canvas hidden from accessibility tree;
- active Hanzi/phase/choices present in DOM;
- logical heading/landmark order;
- no focus loss when target changes;
- dialogs trap and restore focus;
- live regions announce only target/feedback changes, not position frames;
- touch targets at least 44 CSS px;
- contrast AA for text/focus;
- correct/wrong use text/icon beyond color;
- reduced-motion screenshot has no shake/animated scanline class;
- IME composition Enter does not submit.

## 14. Visual regression

Capture at:

- 1440×900 desktop;
- 1024×768 tablet;
- 390×844 and 360×640 mobile;
- normal and reduced motion;
- pinyin, meaning, miss, settings, and summary states.

Compare hierarchy/palette to PNG references, but maintain implementation baselines rather than pixel-diffing directly against design drawings. Mask random star/particle regions or seed the visual RNG. Never mask target highlight, Hanzi, choices, sliders, or save state.

## 15. Performance budgets

On a typical development laptop with production build:

- selected deck JSON parse and app-ready in <1.5 s from local server for largest deck;
- stable 60 fps with 32 enemies at 1440×900; no long task >50 ms during ordinary answer flow;
- pinyin/meaning keydown to visual response <50 ms;
- choice generation <5 ms p95;
- scheduler selection <2 ms p95 for 1,800 words;
- save serialization + local atomic write <100 ms p95;
- no unbounded Phaser objects/listeners after 30-minute soak;
- generated runtime excludes all images/sentence audio.

Use browser Performance panel and a deterministic 30-minute accelerated soak that spawns, answers, lands, pauses, changes settings, and ends/restarts sessions.

## 16. Release gate

Before marking release ready:

- [ ] Source import report has zero blocking errors.
- [ ] Typecheck/unit/integration/e2e/axe pass.
- [ ] Statistical scheduler suite passes with fixed seeds.
- [ ] Real-deck all-word choice test passes.
- [ ] Save atomic failure injection passes.
- [ ] Desktop/mobile visual baselines reviewed.
- [ ] 30-minute soak has no duplicated outcome, cooldown violation, or leaked enemy object.
- [ ] Fresh-clone command sequence in `MAIN.md` succeeds.
