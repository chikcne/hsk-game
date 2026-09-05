# Learn Mode handoff (second slice of the rewrite)

> **Status: PARTIALLY SUPERSEDED.** The Relearn slice (see
> `review-mode.md`) replaced the reserved `relearnSessions` placeholder
> with the single cross-grade `relearnSession` field, and the FSRS review
> rewrite removed everything this document says about latency-based
> auto-grading and review battle word writes. Learn Mode's core contract
> below (one card, explicit ratings, `acquired_words` exactly-once,
> session resume) still holds. The final hardening pass added
> `prepareLearnLaunch` (`src/domain/learn/launch.ts`): launch planning is a
> pure domain step, the created session's level write-back is enforced,
> and reconciliation now adds deck-update words as unintroduced.

## Scope completed

Learn Mode is fully implemented and shipped as the only path that mutates
long-term memory. HSK grade clicks launch Learn sessions (never a battle):
every currently due introduced word of the grade plus up to
`settings.levelSize` new curriculum words, persisted verbatim so relaunching
the grade resumes exactly. Each word is one ts-fsrs card (the old separate
pinyin/meaning memories are gone). The Writing Screen foundation was
integrated as-is: pinyin + meaning visible, audio auto-play + replay, looping
demo for `reps === 0` presentations, Show Demo afterwards, guided writing,
then writing elapsed time + four explicit ratings (Again/Hard/Good/Easy) with
computed next-interval previews before selection. A word leaves the session
when its post-rating card is in FSRS review state (explicit
`completedWordIds`); the earliest due remaining card is always served
(Anki-style learn-ahead); the session ends only when every member has passed.
Words enter the ordered `acquired_words` logical table exactly once, at their
first review-state rating, newest first.

Save schema bumped v3 → v4 with **no migration** (v3 files follow the
existing quarantine/start-fresh flow). Root additions: `acquiredWords`
(logical table `acquired_words`), `learnSessions` per grade (logical
`learn_sessions`), and a **reserved placeholder** `relearnSessions` (logical
`relearn_sessions`, values must stay null until the Relearn slice).

Review arcade is buildable: its domain/client paths were minimally adapted to
the single card (`card.state === "review" | "relearning"`), and review battles
now **never mutate FSRS state** — rounds are finite via the served-exclusion
set (active enemies + already-served keys), and outcomes update only
lifetime counters and the global snapshot. The final acquired-word
quota/retry review algorithm is deliberately NOT implemented — that is the
next agent's work, and `relearnSessions` storage is waiting there too.

## Paths changed

```text
src/shared/schemas.ts                        # v4: single card, WordProgress slimmed, LearnSession, RelearnSession (reserved), acquiredWords
src/domain/memory/                           # single-card bridge: types.ts, card.ts (reviewCardMemory/preview), familiarity.ts; outcome.ts + ratings.ts deleted
src/domain/learning/                         # createLevelProgress (all-unintroduced), curriculumOrder, reconcile, invariants; scheduler.ts + outcomes.ts deleted
src/domain/learn/                            # NEW: session.ts (create/remaining/next/nextDue), ratings.ts (preview + interval format), apply.ts (applyLearnRating, acquireWordKey)
src/domain/review/                           # non-mutating spawn (served-exclusion contract), single-card candidates, countDueReviewWords(levels, now)
src/domain/session/speed.ts                  # single-card wordFamiliarity
src/client/state/useBattle.ts                # review-only: served set, no word writes, simplified feedback/stats
src/client/api/saves.ts                      # v4 blank save; emergency cache accepts v4 only
src/client/data/reviewDeck.ts                # acquired-card pool
src/client/audio/wordAudio.ts                # removed regular-pool audioPoolWordIds
src/client/app/App.tsx                       # deployLearn/resume/caught-up notice, rateLearn, review-only BattleScreen/Summary, settings copy (LEARN MODE / REVIEW MODE), deck select wiring
src/client/app/LearnScreen.tsx               # NEW: writing card + rating panel with previews + summary
src/client/styles/main.css                   # learn screen styles (paper/ink tokens)
src/server/saves/repository.ts               # v4 default save
src/server/saves/validation.ts               # strict v4: card checks, session membership/completions, acquired_words coherence, reserved relearnSessions must be null
README.md, designs/LEARNING_AND_SAVES.md, designs/MAIN.md, designs/UI_SPEC.md, designs/TEST_PLAN.md
tests/domain/learn.test.ts                   # NEW (16 tests: creation cap/order, ratings/previews, learn-ahead, resume, acquisition, completion)
tests/domain/learning.test.ts                # rewritten for session-only introduction
tests/domain/memory.test.ts                  # rewritten single-card
tests/domain/review.test.ts                  # rewritten non-mutating + served exclusion
tests/domain/workload.test.ts                # 90-day Learn-session simulation
tests/integration/runtime.test.ts            # learn flow slice
tests/server/{helpers,api,saves}.test.ts     # v4 fixtures, session/acquired validation, v3 quarantine test
tests/client/learn-screen.test.tsx           # NEW SSR markup tests
tests/client/word-audio.test.ts              # dropped audioPoolWordIds test
```

## Public contracts used/added

- `WritingCard` (unchanged): mounted with `key={word.id}`,
  `isNewCard={card.reps === 0}`, `onWordComplete` opens the rating panel.
- `createLearnSession(deck, level, now, { newCardLimit, spawnOrdinal })` →
  `{ level, session }`; throws `RangeError` when nothing is learnable (App
  shows the caught-up notice with `nextLearnDueAtMs`).
- `nextLearnCardId(session, level, now)` → `{status:"card", wordId, dueNow}`
  | `{status:"complete"}`; earliest due, stable-ID ties, learn-ahead.
- `previewLearnCard(card, rating, now)` + `formatLearnInterval(ms)`.
- `applyLearnRating(save, deckId, wordId, rating, now)` →
  `{ save, card, newlyAcquired, wordCompleted, sessionCompleted }` — the only
  card mutation path; used verbatim by the client (`rateLearn`) so tests and
  runtime share one semantic.
- `remainingLearnWordIds(session, level)`, `acquireWordKey`.
- Save v4 root: `acquiredWords: string[]` (`"deckId:wordId"` keys, newest
  first), `learnSessions: Record<DeckId, LearnSession | null>` with
  `{ deckId, deckFingerprint, startedAt, wordIds, completedWordIds, currentWordId }`,
  `relearnSessions` (reserved, always null for now).

## Commands run and results

```text
npm test        # typecheck + 24 files / 181 tests pass
npm run build   # typecheck + vite build pass (dist emitted)
```

Live smoke: booted the server against a temp dir — GET returns a coherent v4
default; PUT with an active learn session round-trips; unknown session
members / duplicate acquired keys are rejected 400 with issue paths; beacon
accepts a session-completing snapshot; a real v3 save triggered quarantine →
`save_corrupt` recovery response (start-fresh path).

## Key semantics (for the next agent)

1. Removal from a session is **rating-time and explicit**
   (`completedWordIds`), NOT derivable from card state: a due maintenance
   card that already sits in review must still be served once. Do not
   "simplify" this back to a state predicate.
2. `acquired_words` order is the acquisition history (newest first) and is
   append-at-front, exactly-once. The review/relearn quota work should treat
   it as the entry ticket + ordering ledger.
3. Review battle must remain memory-neutral; if the new review algorithm
   needs per-word spacing, add explicit fields (schema is still
   fresh-start/no-migration) rather than resurrecting card mutation.
4. `relearnSessions` is validated-but-null everywhere; fill in the workflow
   and evolve the placeholder shape as needed.
5. `settings.levelSize` is "new cards per session" (5–20, step 5). It may
   split a fixed 20-card authored lesson but never pull from the next lesson.

## Known limitations / follow-ups

- Review rounds serve each due card exactly once per round with arcade
  scoring; the final quota/retry algorithm (and any review-driven repair
  loop) is intentionally deferred.
- Learn-ahead has no waiting screen by design; a "next review at HH:MM"
  caught-up notice exists on the grade screen only.
- No E2E/browser tests in-repo (fits the later P9 slice); Learn is covered by
  pure-domain tests plus SSR markup tests.
