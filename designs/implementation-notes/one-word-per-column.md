# One live word per battlefield column — implementation notes

## Rule

Battle Mode never puts two live words in the same column. A spawn takes a
column only if that column is empty; when every column is taken, all spawn
timing freezes (the pending interval stops elapsing) until a word is answered
or reaches the ground, and the held spawn is then served immediately.

## Why a slot space, not a column index

`GameCanvas` renders one enemy element whose horizontal position is published
as two CSS variables (`--desktop-x` for the 12-column grid, `--mobile-x` for
the 6-column grid), so a single word must be collision-free in *both* layouts
without any re-render when the breakpoint or the device orientation changes.

Words are therefore assigned a `columnSlot` in a 12-slot space, and occupancy
is compared modulo `COLUMN_PERIOD` (6, the coarsest responsive count). Because
6 divides 12, slots that differ modulo 6 land in different columns at 6 *and*
at 12 columns, so rotating a phone mid-battle can never create an overlap and
no in-flight word ever has to be moved to a new column.

The consequence is a hard ceiling of 6 concurrent words, on desktop too, where
they occupy 6 of the 12 columns (never two columns that are 6 apart). Steady
state at the default 5 s interval already sits near 5 words, so the freeze
engages mainly during fast, mastered-heavy stretches.

## Paths changed

- `src/domain/session/columns.ts` (new) — `COLUMN_SLOTS`, `COLUMN_PERIOD`,
  `columnClass`, `occupiedColumnClasses`, `nextFreeColumnSlot`. The last
  scans right-to-left from a cursor and returns `null` when every column is
  occupied.
- `src/domain/session/types.ts` — `Enemy.columnSlot`.
- `src/domain/session/targeting.ts` — `battlefieldColumn` reads `columnSlot`
  instead of `spawnOrdinal`, so column choice is no longer implied by spawn
  order. `spawnOrdinal` still drives cadence, `lane`, and age tie-breaks.
- `src/client/state/useBattle.ts` — a `columnCursor` ref advances past each
  assigned slot; the animation loop asks for a free slot before deciding a
  spawn, passes it to `reserveSpawn`, and adds the frame delta to `spawnDue`
  while no column is free so the pending wait cannot burn down during the
  stall. `MAX_ACTIVE_ENEMIES` is now subsumed by the column ceiling and kept
  only as a guard.

## Commands run and results

- `npm run typecheck` — 0 errors.
- `npx vitest run tests/domain/session-columns.test.ts tests/domain/session.test.ts tests/client/game-canvas.test.tsx` — pass.
- `npm run test:unit` — 344 pass, 4 failures, all pre-existing and unrelated
  (`tests/server/config.test.ts`, `tests/server/api.test.ts` YAML expectations
  and `tests/import-decks/archive-sqlite.test.ts`'s missing `decks/*.apkg`).
  Verified by stashing these changes and re-running the same files.

## Known limitations / follow-ups

- `useBattle` still has no hook-level test, so the freeze itself is covered
  only through `nextFreeColumnSlot`; the pure helper returning `null` is what
  the loop keys off.
- The `--overlap-offset` jitter in `GameCanvas` is now dead weight: with one
  word per column there is nothing to offset.
