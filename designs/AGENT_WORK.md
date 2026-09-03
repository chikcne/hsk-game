# Small-agent implementation work packages

## 1. Operating rules

Each agent receives one package, reads `designs/MAIN.md` plus linked documents relevant to it, and returns a tested commit-sized change with a handoff note.

Rules:

1. Do not modify `decks/*.apkg` or `decks/SHA256SUMS`.
2. Do not weaken a shared Zod schema to make local code pass.
3. Keep pure domain code free of React, Phaser, Fastify, browser, and filesystem imports.
4. Add tests in the same package; do not defer ordinary unit coverage to the last agent.
5. Avoid drive-by formatting or edits in another package's owned paths.
6. If a frozen contract is insufficient, stop and document the exact proposed change instead of creating a parallel incompatible type.
7. Run the package acceptance commands and report actual results.
8. Write `designs/implementation-notes/<package>.md` with changed paths, commands/results, assumptions, and follow-ups.
9. Generated `public/game-data/` and local `saves/` must remain ignored.
10. Use deterministic seeds/fake clocks in tests; no timing sleeps.

A useful handoff format:

```md
# Pn handoff
- Scope completed:
- Paths changed:
- Public contracts used/added:
- Commands run and results:
- Known limitations:
- Suggested next agent:
```

## 2. Contract freeze before parallel work

P0 must freeze these before P1/P2/P3/P4 split:

- `RuntimeDeck`, `RuntimeWord`, deck index, and import report schemas;
- `SaveFileV1`, settings, level, and word-progress schemas;
- `SessionEvent`, `SessionState`, `EncounterOutcome`, and command schemas;
- `RandomSource`, scheduler input/output, and clock interfaces;
- API request/response schemas;
- constants for HSK IDs, choice keys, weight/settings bounds.

Contract files should export inferred TypeScript types from Zod where serialization is involved. In-memory simulation types that contain Phaser objects never belong in shared schemas.

## 3. Dependency and parallelization map

```text
P0 foundation/contracts
├── P1a APKG archive/SQLite reader
│     └── P1b normalizer/index/audio compiler
├── P2 learning scheduler
├── P3 save server/repository
└── P4 encounter reducer/scoring (uses P2 interfaces)
      ├── P5 Phaser battlefield
      └── P6 React screens/components

P1b + P3 + P4 + P5 + P6
└── P7 application integration/audio/settings
      └── P8 responsive/a11y/pixel polish
            └── P9 full-source/E2E/performance hardening
```

Safe parallel groups:

- after P0: P1a, P2, and P3;
- after P2: P4 while P1 continues;
- after P4: P5 and P6;
- P7 is the first broad integration point and should run alone against merged work.

## 4. P0 — foundation and frozen contracts

### Goal

Create a runnable strict-TypeScript skeleton and contract layer with no fake gameplay implementation.

### Owned paths

```text
package.json package-lock.json
vite.config.ts tsconfig*.json index.html
src/shared/**
src/domain/*/types.ts
src/client/main.tsx src/server/index.ts (minimal boot/health only)
tests/setup/**
```

### Deliverables

- React/Vite client renders a plain boot screen.
- Fastify loopback server exposes `/api/health` and can serve production build later.
- Development script runs Vite plus server with `/api` proxy.
- Strict TS config covers client/server/tools/tests with appropriate libs.
- Vitest has node and jsdom projects or explicit configs.
- Shared constants/schemas listed in the freeze section exist with compile-only fixture tests.
- Anticipated dependencies are installed once to reduce later `package.json` conflicts:
  - runtime: React, React DOM, Phaser, Zustand, Zod, Fastify, static serving;
  - tooling: Vite/plugin, TypeScript, tsx/concurrent runner, Vitest, Playwright, fast-check, lazy ZIP, SQLite reader, font packages/types.
- `.gitignore` remains compatible with decks, generated data, and saves.

### Acceptance

```text
npm ci
npm run typecheck
npm run test:unit
npm run dev   # health and boot screen smoke check
npm run build
npm start     # production static + health smoke check
```

### Not in scope

Deck parsing, save writes, scheduler behavior, Phaser scene, styled screens.

## 5. P1a — APKG archive and SQLite reader

### Goal

Safely expose typed raw notes/media references from the six APKG inputs without performing game-specific normalization.

### Prerequisite

P0.

### Owned paths

```text
tools/import-decks/archive/**
tools/import-decks/sqlite/**
tools/import-decks/raw-types.ts
tests/fixtures/apkg/**
tests/import-decks/archive*.test.ts
```

### Deliverables

- Streaming package SHA-256 verification.
- Lazy two-pass ZIP utility and temporary-directory cleanup.
- Read-only extraction/open of `collection.anki21`.
- Ten-field model validation and typed raw-note iteration in stable note-ID order.
- `media` JSON parsing, reverse filename/member index, safe member-name checks.
- Strict `[sound:...]` parser.
- Original synthetic fixture builder/content with at least 30 notes.
- Failure tests for corrupt ZIP, wrong fields/model, unsafe media, missing collection/media.
- No extraction of images or arbitrary templates.

### Acceptance

- Fixture notes/media match expected snapshots.
- Real source smoke prints exact note counts 300/200/500/1000/1601/1800.
- Memory does not scale with full uncompressed media size.

### Handoff contract

Export an async iterator/reader that P1b can consume without knowing SQLite table details.

## 6. P1b — normalization, dedupe, indexes, and audio compiler

### Goal

Produce deterministic validated `public/game-data` exactly as specified in `DATA_PIPELINE.md`.

### Prerequisite

P1a and P0 schemas.

### Owned paths

```text
tools/import-decks/normalize/**
tools/import-decks/compile/**
tools/import-decks/overrides.json
tools/import-decks/cli.ts
tests/import-decks/normalize*.test.ts
tests/import-decks/compile*.test.ts
```

### Deliverables

- HTML/entity sanitization.
- NFKC Hanzi normalization, sense parsing, CJK validation, reviewed `劳动` override.
- Correct pinyin canonicalization with `ü/u:` → `v` and slash variants.
- Stable semantic IDs and exact duplicate merge.
- Word-audio-only streaming extraction to content hashes.
- Runtime meaning reverse index, POS pools, and global pool.
- All-word safe distractor validation.
- Deterministic stable JSON and atomic generated-directory swap.
- `index.json` and detailed `import-report.json`.
- CLI/package scripts and stale-data detector.

### Acceptance

- Expected logical counts: 300/200/500/1000/1600/1798.
- Every source word audio resolves; every logical word has local audio.
- Two clean imports are byte-identical.
- No image or sentence audio appears in output.
- Rejected import leaves prior generated directory unchanged.
- Real import report has no blocking errors.

### Do not

Embed generated JSON/audio in source code, use array index as word ID, render source HTML, or silently repair unexpected Hanzi.

## 7. P2 — pure learning scheduler and mastery

### Goal

Implement deterministic selection, hard spacing, continuous grades, step scheduling, completion, and reconciliation helpers.

### Prerequisite

P0.

### Owned paths

```text
src/domain/random/**
src/domain/learning/**
tests/domain/random*.test.ts
tests/domain/learning*.test.ts
```

### Deliverables

- Serializable xoshiro128** `RandomSource`.
- Hard minimum spacing (two intervening words) reserved at every spawn.
- Absolute-ordinal eligibility with exact “other spawns” semantics; wall-clock dueAt for graduated words.
- Deterministic 30-word curriculum/refill and mastered-relapse reinsertion.
- Due-state buckets with 50/30/20 target mix, urgency lottery, ungraded practice fallback, and anti-starvation override.
- Again/Hard/Good/Easy continuous grading, 3/10/30 learning steps, 2/6/18 relearning steps, and stability/difficulty growth.
- live completion/permanent milestone transition.
- deck-fingerprint progress reconciliation by stable ID.
- invariant validator/assertions.
- fixed-seed statistical and property tests.

### Acceptance

- 100k-spawn simulation has zero cooldown violations.
- save/reload midway produces same schedule as uninterrupted run.
- all boundary formulas in `TEST_PLAN.md` pass.
- code imports no UI/server frameworks.

### Handoff contract

P4 calls pure `spawnNextWord(level, deck, rng)` and `applyOutcome(progress, outcome, now)` functions returning immutable state plus transitions.

## 8. P3 — local save API and atomic repository

### Goal

Make `saves/default.json` authoritative, safe, versioned, and observable.

### Prerequisite

P0.

### Owned paths

```text
src/server/saves/**
src/server/routes/saves.ts
src/server/app.ts
tests/server/saves*.test.ts
tests/server/api*.test.ts
```

### Deliverables

- GET/PUT/beacon routes with Zod validation and 2 MiB limit.
- default save factory from generated deck manifests.
- server-owned revisions and 409 conflict handling.
- single serialized/coalescing write queue.
- exclusive temp write, flush, atomic rename, backup, directory sync where supported.
- temp cleanup, corrupt quarantine, backup recovery.
- Current-schema validation fixtures (development saves are reset on incompatible changes).
- loopback binding and no profile/path traversal surface.
- fault-injection tests at write stages.

### Acceptance

All save/API scenarios in `TEST_PLAN.md` pass in temporary directories; tests never touch repository `saves/`.

### Handoff contract

P7 receives a generated/typed client or small API adapter contract, not raw unvalidated `fetch` calls scattered across components.

## 9. P4 — encounter reducer, timing, choices, and scoring

### Goal

Implement the pure state machine joining enemies, answer phases, one-outcome semantics, choices, score, and streak.

### Prerequisites

P0 and P2 public interfaces.

### Owned paths

```text
src/domain/deck/pinyin.ts
src/domain/session/**
tests/domain/pinyin*.test.ts
tests/domain/session*.test.ts
```

### Deliverables

- pinyin submission matching against precompiled accepted forms.
- predicted-arrival targeting by progress/speed/ordinal with a persistent target lock.
- pinyin/meaning/miss/hit/pause/end transitions.
- safe eight-choice generator using meaning indexes and separate RNG.
- exactly-once enemy resolution guard.
- active-time response clocks.
- score/streak/session-stat formulas.
- ordered reducer commands, including audio and checkpoint requests.
- deadline-race behavior and tests.

### Acceptance

State/event matrix, choice safety, duplicate callback, scoring, and timing tests all pass without Phaser/React.

### Handoff contract

P5/P6 consume immutable view state and dispatch typed events; they do not duplicate rules.

## 10. P5 — Phaser multi-enemy battlefield

### Goal

Render and simulate a mastery-speed-scaled multi-enemy pressure queue controlled entirely by typed state/events.

### Prerequisite

P4 event/view contract.

### Owned paths

```text
src/client/game/**
public/art/** (original sprite atlas only)
tests/client/game*.test.ts
```

### Deliverables

- Phaser boot/config with pixel settings.
- fixed-step active clock, visibility/pause handling, no burst catch-up.
- 8 lanes, 0–1 progress mapping, up to 32 active enemies.
- one global speed factor plus a deterministic mastery-derived factor for every active/future enemy.
- all enemy Hanzi overlays and length-aware sizing.
- amber predicted-arrival target lock, danger state, base/turret.
- spawn/remove/land animation adapters and late-callback guards.
- original sprite atlas/effects matching palette.
- headless simulation adapter tests where feasible.

### Acceptance

Default produces multiple enemies; predicted-arrival lock changes only after resolution; global speed apply preserves arrival ordering; no Phaser object/listener leak in accelerated lifecycle test.

### Do not

Select words, calculate mastery, score answers, own save state, or read keyboard answer keys directly.

## 11. P6 — React screens and interaction components

### Goal

Build accessible DOM screens matching the PNG hierarchy against mocked coordinator snapshots.

### Prerequisite

P4 view/event contract; may run parallel with P5.

### Owned paths

```text
src/client/app/**
src/client/components/**
src/client/styles/**
tests/client/components*.test.tsx
```

### Deliverables

- deck selection/loading states.
- battle HUD and pinyin form with composition handling.
- eight-key meaning grid and R replay event.
- feedback queue, pause, settings, summary, save/error states.
- settings sliders/ranges/cancel/apply semantics in UI.
- keyboard focus/dialog behavior and live regions.
- mock coordinator/story/test harness for every PNG state.
- initial desktop/tablet/mobile CSS structure and local fonts.

### Acceptance

Component tests cover keyboard, IME, ignored keys, dialog focus, settings validation, long meanings, and save truthfulness. No component calculates scheduler/gameplay rules.

## 12. P7 — application coordinator, audio, saves, and settings integration

### Goal

Connect generated decks, pure domain, React, Phaser, audio, and save API into the first fully playable vertical slice.

### Prerequisites

P1b, P3, P4, P5, P6 merged.

### Owned paths

```text
src/client/state/**
src/client/audio/**
src/client/api/**
src/client/app/App.tsx (integration only)
tests/integration/**
```

### Deliverables

- boot/load generated index and selected deck.
- initialize/migrate level progress and three RNG streams.
- coordinate spawn clock, reducer, Phaser commands, and React snapshots.
- unlock/preload/play/replay local word audio with failure handling.
- coalescing client checkpoint queue and save status.
- settings pause/apply/persist, uniform active speed update, no spawn burst.
- voluntary end/flush/summary/resume.
- visibility handling and deadline event ordering.
- deterministic fake renderer/audio/API integration harness.

### Acceptance

All integration scenarios in `TEST_PLAN.md` pass and a developer can complete a real HSK word loop in the browser with a local save written.

### Integration caution

P7 may expose previously insufficient frozen contracts. Make the smallest reviewed contract change and update both producer/consumer tests in one change; do not move domain logic into the coordinator.

## 13. P8 — responsive, accessibility, and pixel-art polish

### Goal

Bring the integrated vertical slice to the supplied desktop/mobile visual and accessibility bar.

### Prerequisite

P7.

### Owned paths

```text
src/client/styles/**
src/client/components/** (presentation/a11y only)
src/client/game/** (visuals only)
public/fonts/** public/art/**
tests/e2e/accessibility*.spec.ts
tests/visual/**
```

### Deliverables

- 1440×900, 1024×768, 390×844, and 360×640 layouts.
- mobile software-keyboard/visualViewport handling and 2×4 touch choices.
- long-meaning wrapping with no semantic truncation.
- target/Hanzi/status DOM duplication and restrained live announcements.
- focus rings, dialog trap/restore, touch targets, contrast.
- reduced motion and no rapid flashing.
- local fonts and final original pixel sprites/effects.
- seeded visual screenshots for all reference states.

### Acceptance

Axe passes, keyboard-only loop works, mobile loop works, and reviewed screenshots match PNG hierarchy/palette.

### Do not

Change formulas, cooldowns, save semantics, or event ordering under a visual-polish task.

## 14. P9 — full-source, E2E, performance, and release hardening

### Goal

Verify the entire application with all six real decks and close release risks rather than adding features.

### Prerequisite

P8.

### Owned paths

```text
tests/e2e/**
tests/performance/**
tests/fixtures/migrations/**
scripts/release-check.*
README.md
```

Production fixes may touch owning modules only when accompanied by a regression test and noted in handoff.

### Deliverables

- all Playwright journeys in `TEST_PLAN.md`;
- all-word choice/audio/index validation against real generated data;
- scheduler long run and restart reproducibility;
- save fault/recovery and second-tab conflict E2E;
- 30-minute accelerated soak with object/listener counters;
- performance measurements/budgets;
- fresh-clone release script and user README;
- final requirements traceability checklist.

### Acceptance

The release gate in `TEST_PLAN.md` is fully checked with recorded commands/results. No test is skipped merely because a real deck is large; classify slow source tests separately if needed.

## 15. Suggested first implementation wave

After P0 is complete, start three agents:

```text
Agent A -> P1a source reader
Agent B -> P2 scheduler/mastery
Agent C -> P3 save repository/API
```

When P2 lands, start P4. When P1a lands, start P1b. Merge P4 before splitting P5 and P6. Keep P7 as a single deliberate integration pass.

This order minimizes shared-file conflicts and makes the riskiest nonvisual requirements—source integrity, never-repeat cooldown, and atomic local progress—testable before game polish.
