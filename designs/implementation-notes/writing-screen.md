# Writing Screen foundation handoff (P-WRITE, first slice of the rewrite)

## Scope completed

Reusable, isolated Writing Screen card implementing the Inkstone-inspired
single large tian-zi square: pinyin + meaning pinned above the grid, one
active character at a time for phrases of any length, word audio on card
appearance with a replay button, guided forgiving stroke-order/shape quiz with
hints, a grey character outline shown only while a demo plays (looping demo
for new cards, or Show Demo — the quiz runs on a blank square), looping
stroke-order demo for new
cards until the surface is engaged, a Show Demo control for later cards, a
bottom-center hangman-style progress row, elapsed writing time + completion
callback, an explicitly labeled accessible finish control with confirmation,
and reduced-motion support. No existing file outside the new module was
modified; App.tsx, save schemas, FSRS, useBattle, and the server are untouched.
Rating controls intentionally do not exist here yet.

Reference behavior was taken from skishore/inkstone (dashed guide cross,
grey watermark outline, next-stroke highlight, calm warning copy, completed
glyphs moving to a corner row, tap-to-advance surface); all code is original
and built on the pinned local `hanzi-writer@3.7.3` + local Make Me a Hanzi
bundles via the existing `charDataLoader` pattern. No CDN, no new data.

## Paths changed

```text
src/client/writing/writingProgress.ts      # pure state machine (phase, clock, skips, misses)
src/client/writing/writingFeedback.ts      # pure hint/feedback copy selection
src/client/writing/useCardAudio.ts         # hook: play-on-appear + replay (reuses audio/wordAudio)
src/client/writing/usePrefersReducedMotion.ts
src/client/writing/WritingGrid.tsx         # imperative hanzi-writer wrapper (demo-loop | demo-once | writing)
src/client/writing/WritingCard.tsx         # composing card component
src/client/styles/writing.css              # isolated styles (tokens from main.css :root)
tests/client/writing-progress.test.ts
tests/client/writing-feedback.test.ts
tests/client/writing-card.test.tsx
designs/implementation-notes/writing-screen.md
```

## Public contract for the next (Learn) agent

```ts
import { WritingCard, type WritingCardWord, type WordWritingResult } from "…/client/writing/WritingCard";

<WritingCard
  word={{ id, displayHanzi, displayPinyin, meaning }}   // RuntimeWord maps directly
  strokeData={mergedStrokeDataMap}                      // existing loadStrokeBundle(s) result
  isNewCard={boolean}                                   // never-seen word → looping demo first
  reducedMotion={settings.reducedMotion || system}      // OS preference also honored internally
  audioSource={wordAudioSource(deckId, word)}           // resolved local URL; "" disables
  audioVolume={masterVolume}
  onWordComplete={(result: WordWritingResult) => {
    // result.elapsedMs: writing time only. The clock starts at demo engagement
    //   for new cards, or at the FIRST QUIZ STROKE (correct or mistaken) for
    //   later cards, so first-character time is counted; demo watching is
    //   excluded. Milliseconds, 0 if all characters finished unwritten.
    // result.skippedCharacters: characters the PLAYER finished via the
    //   accessible control (a deliberate choice)
    // result.missingDataCharacters: characters auto-finished because their
    //   stroke data was absent (not the player's choice) — kept separate
    // result.totalMisses: rejected stroke attempts across the word
    // → attach rating controls here (FSRS rating belongs to the caller, not this component)
  }}
/>
```

Guarantees:

- `strokeData` must be FULLY LOADED before mount: every Han character of the
  word must already be in the map (an awaited `loadStrokeBundle(s)` result).
  The card never fetches lazily; a missing character is finished
  automatically (status `missing`, counted in `missingDataCharacters`) and
  logged, so it can never trap the player — but it cannot be written.
- `onWordComplete` fires exactly once per word (also when finished purely
  without writing → `elapsedMs: 0`).
- Mount with `key={word.id}` to hard-swap cards, or rely on the internal
  reset-on-`word.id`-change; both are safe. Unmounting pauses and discards
  audio and destroys the writer (StrictMode double-mount safe).
- `Show Demo` mid-character cancels the quiz and restarts that character from
  stroke 0 afterwards; the grey outline is visible only during demos (new-card
loop and Show Demo) and hides as soon as the quiz starts.
- Keyboard focus is preserved: canceling the skip confirm (KEEP WRITING or
  Escape) returns focus to the FINISH WITHOUT WRITING opener, and when a demo
  hands over to the quiz (new-card engagement or Show Demo finishing) focus
  moves to the writing square (programmatic focus only, `tabindex="-1"`).
- Word-audio playback failure is exposed accessibly: the replay button's
  accessible name reports the failed attempt and a live region announces that
  the replay button retries.

## Assumptions

- Phrases are 1–4 Han characters today; non-Han characters are rendered in the
  progress row but never become writing targets.
- Autoplay may reject before the first user gesture; failures set the error
  state and the replay button stays available.

## Commands run and results

```text
npm run typecheck          # pass
npx vitest run             # 22 files, 168 tests pass (incl. 29 new writing tests)
npm run build              # pass; writing.css bundled into the main CSS asset
```

## Known limitations / follow-ups

- No jsdom/playwright in the repo, so the interactive hanzi-writer loop is
  covered by SSR tests + verified API assumptions against the 3.7.3 source
  (loopCharacterAnimation loops via `{loop: true}`, markStrokeCorrectAfterMisses
  force-accepts and fires onCorrectStroke, showHintAfterMisses highlights);
  E2E coverage fits P9.
- Reduced-motion "demo" holds the finished glyph statically (no animation) by
  design.
- Rating UI, session wiring, and deck-flow integration are deliberately left
  to the Learn agent.

## QA fix pass (focused defects)

- Timing: on later (non-demo) cards the clock now starts at the first quiz
  stroke — correct or mistaken — instead of at the first character
  completion, so first-character writing time is counted.
- Stroke feedback resets when the word or active character changes even if
  the next word begins with the same character (reset keyed on
  `wordKey`+`activeIndex`, not the character alone).
- `GridStrokeEvent.totalStrokes` is computed per hanzi-writer 3.7.3
  semantics: `strokesRemaining` discounts the stroke only when it was
  correct, so mistake callbacks previously reported `totalStrokes` one too
  high (`toGridStrokeEvent(data, isCorrect)`, unit tested).
- Player skips and missing-stroke-data characters are distinct: status
  `missing` + `missingCount`/`missingDataCharacters` vs `skipped` +
  `skippedCount`/`skippedCharacters`.
- Audio playback failure is announced (live region + replay button accessible
  name) instead of only styling the button.
- Keyboard focus preserved on skip-cancel and demo→quiz handover.
- Documented that `strokeData` must be fully loaded before mount.
