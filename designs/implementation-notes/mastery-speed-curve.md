# Answer-speed mastery curve + second chance — implementation notes

## Scope completed

Battle mastery no longer moves by a flat ±`masteryDelta`. A dedicated **answer
clock** starts the moment a word becomes the locked target and runs across BOTH
the pinyin and the meaning phase; the gain is read off a piecewise-linear curve
through three configured anchors. Passing the floor anchor opens **second
chance**: the whole battlefield freezes, the answer becomes untimed, and a
correct answer there holds mastery flat. Reaching the ground is no longer an
outcome at all — the word vanishes silently.

Committed tuning (all of it in `config/battle.yaml`):

| Answer clock | Mastery |
| --- | --- |
| ≤ 2000 ms | +20 (`masteryCurve.maxGain`) |
| 5000 ms | +10 (`masteryCurve.midGain`) |
| 8000 ms | +1 (`masteryCurve.floorGain`) |
| ≥ 8000 ms | second chance → +0 (`masteryCurve.secondChanceGain`) |
| any wrong answer, any time | −10 (`masteryDelta`) |
| word reaches the ground | 0, nothing posted |

Altitude relief on a correct answer is now unconditional (the
`DANGER_ZONE_PROGRESS` gate is gone): `relief.correct` = 0.10, or
`relief.secondChance` = 0.05 when the answer came in second chance. A wrong
answer grants none.

The pinyin autocomplete/reveal mechanic is **deleted** — second chance is the
sole slow-answer path and the player always guesses.

## Paths changed

- `config/battle.yaml` — new `masteryCurve` (7 keys) and `relief` (2 keys)
  sections; `masteryDelta` redocumented as the wrong-answer cost only.
- `src/shared/battle.ts` — `BattleConfigSchema` extended with `masteryCurve` +
  `relief`, plus a `superRefine` requiring `maxMs < midMs < floorMs`; new
  `BattleOutcomeSchema` discriminated union
  (`correct{answerMs}` | `secondChance` | `wrong`) replacing the wire-level
  `cleanCorrect: boolean`.
- `src/domain/battle/outcome.ts` — `speedMasteryGain` (piecewise-linear, flat
  below `maxMs`, clamped at `floorGain`, rounded to an integer),
  `masteryDeltaFor`, `opensSecondChance`, `reliefForCorrect`;
  `applyMasteryOutcome` now takes a `BattleOutcome` instead of a boolean.
- `src/domain/session/landing.ts` — `advanceEnemiesForRecallWindow` replaced by
  `advanceEnemies(enemies, advance) -> { active, vanished }`; nothing parks at
  the landing line any more. `moveEnemiesUp` takes the relief fraction as an
  argument instead of the deleted `AUTOCOMPLETE_RELIEF_PROGRESS` constant.
  `PINYIN_RECALL_WINDOW_MS` and `PINYIN_AUTOCOMPLETE_DELAY_MS` are gone.
- `src/domain/session/types.ts` — `EncounterOutcome` loses the `landed` variant
  and the `pinyinAutocompleted` flags; `Enemy` loses
  `pinyinTimeoutStartedAtMs`; `SessionEvent`'s `enemyLanded` → `enemyVanished`.
- `src/domain/session/credit.ts` — `encounterCredit`'s second parameter is now
  `secondChance` rather than `revealed`; the semantics (no points, no streak,
  not counted in accuracy) carry over unchanged.
- `src/client/state/useBattle.ts` — new `answerStarted` clock (reset on every
  target lock, shifted by pause/hidden/feedback suspensions like
  `phaseStarted`); `secondChance` state + ref + `secondChanceStarted`; the rAF
  tick opens second chance and then early-returns, so descent, spawning, and
  vanishing all freeze while input stays live; `resolveEnemy` captures the
  second-chance flag BEFORE `commitEnemies` relocks the target, hands the
  frozen duration back to `spawnDue`, and applies the configured relief;
  `updateWord` builds the `BattleOutcome` and posts it; vanished words go
  through `recordVanished` (per-word tally only — no outcome, no feedback, no
  streak change, not counted as a resolved spawn). Stats swap `landed`/
  `autocompleted` for `vanished`/`secondChance`; `Feedback.revealed` →
  `Feedback.secondChance`; the hook exposes `secondChance` instead of
  `pinyinAutocompleted`.
- `src/client/api/battle.ts` — `postVocabOutcome(cardId, outcome)`, body
  `{ outcome }`.
- `src/server/routes/saves.ts` — outcome body is `{ outcome }` validated by the
  shared `BattleOutcomeSchema`.
- `src/server/saves/repository.ts` — `applyOutcome(cardId, outcome)` computes
  the delta with the shared `masteryDeltaFor`, so the server stays the mastery
  authority and the client's optimistic mirror is the same function.
- `src/server/config.ts` — `EXPECTED_KEYS` covers the two new sections (strict
  key-set validation still rejects anything missing, extra, or renamed).
- `src/client/app/App.tsx` — second-chance banner in the answer console, a
  `second-chance` class on the battle screen, the field freezes visually, the
  autocomplete strings are replaced, the correction notice reports a
  second-chance answer, and the summary ranking reports
  `WRONG · SECOND CHANCE · MISSED`.
- `src/client/styles/main.css` — `.second-chance-banner` and the
  `.battle-screen.second-chance` field treatment.
- `tools/import-strokes/extract.ts` + regenerated
  `public/stroke-data/{ui.json,manifest.json}` — UI bundle extended with 再来
  for the banner (80 UI characters; the 1941 total is unchanged because both
  already ship in the HSK bundles).
- Docs: `README.md`, `designs/GAMEPLAY.md` (state machine, timing, outcome
  contract, new §9 "Vanishing, second chance, and feedback"),
  `designs/MAIN.md`, `designs/UI_SPEC.md`, `designs/TEST_PLAN.md`,
  `designs/LEARNING_AND_SAVES.md` status banner.

## Public contracts used/added

- `BattleOutcome` in `src/shared/battle.ts` is the one shared definition for the
  outcome endpoint; client and server both derive the mastery delta from
  `masteryDeltaFor`, so no second copy of the curve exists.
- The server now imports one pure domain module (`src/domain/battle/outcome`).
  Domain purity is intact — no React/Fastify/fs imports crossed either way.

## Tests

- `tests/domain/battle.test.ts` — curve anchors hit exactly (2s/5s/8s →
  20/10/1), flat maximum band, monotone decrease across 0..9s, linear
  interpolation at the segment midpoints, floor clamp beyond the threshold,
  `opensSecondChance` boundary at exactly `floorMs`, per-kind deltas, 0..100
  clamping, ten midpoint answers vs five maximum-speed answers both reaching
  100, and the two relief fractions.
- `tests/domain/session.test.ts` — grounded words vanish while the rest stay,
  nothing is ever parked at progress 1, and relief lifts by the given fraction
  without passing the top of the field.
- `tests/server/config.test.ts` — the committed YAML still round-trips to the
  fixture, and new rejection cases for a missing `masteryCurve`/`relief`
  section, renamed keys, non-increasing anchor times, fractional gains, and
  out-of-range relief.
- `tests/server/{api,saves}.test.ts` — outcome payloads are
  `{ outcome: {...} }`; invalid-body coverage now includes `outcome: true`, a
  `correct` without `answerMs`, a negative `answerMs`, an unknown kind, and an
  extra top-level key.
- `tests/client/battle-api.test.ts` — the POST body carries `{ outcome }`, plus
  a case for second-chance and wrong outcomes posting no answer time.
- `tests/integration/runtime.test.ts` — the server simulator takes a
  `BattleOutcome`; the graduation walk uses midpoint answers, and the demotion
  step first asserts a second-chance answer holds mastery at 100.

## Commands run and results

- `npx tsc --noEmit` — 0 errors.
- `npx vitest run` — 334/335 pass. The single failure is pre-existing and
  environmental: `tests/import-decks/archive-sqlite.test.ts` needs
  `decks/hsk-2-1488171715.apkg`, and `decks/` has no tracked files at this
  branch's HEAD. Verified by stashing this branch's changes and re-running the
  file: it fails identically without them.
- `npm run build` — success (pre-existing >500 kB Phaser chunk warning).
- `npm run import:strokes -- --source /tmp/graphics.txt` — 1941 characters,
  checksum-verified source.

## Known limitations / follow-ups

- `useBattle` still has no unit test: the second-chance trigger, the answer
  clock's suspension bookkeeping, and the vanish path are exercised only
  through their extracted pure helpers (`opensSecondChance`, `advanceEnemies`,
  `moveEnemiesUp`, `masteryDeltaFor`). A fake-rAF/fake-clock harness for the
  hook is the natural next step.
- A word can now be selected while already near the ground and vanish in well
  under 8 seconds, so it never gets a fair answer window. That is the approved
  behaviour (vanishing is free), but if the backlog ever feels unfair, the fix
  is a minimum altitude for target selection rather than a return of the recall
  window.
- `DANGER_ZONE_PROGRESS` is now purely cosmetic (the `is-danger` class and the
  次 mark in `GameCanvas`); it no longer gates any rule.
- `masteryCurve` gains are integers because the `vocab.mastery` column is an
  integer; interpolated values round to nearest. Sub-integer tuning would need
  a schema change.
