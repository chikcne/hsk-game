# Confusable distractors handoff

## Scope completed

Review Mode's meaning choices no longer offer a distractor the data pipeline
has marked confusable with the answer unless the pool starves. 说 ("to speak,
to say") can no longer be "answered" with 说话's "to talk" while eight honest
slots exist; the near-synonym becomes the last-resort tier instead of a
failure mode on small acquired pools.

## Paths changed

- `src/domain/session/confusables.ts` — new. Parses
  `src/shared/data/confusable-meanings.json` once at module load into
  `meaningKey → Set<groupId>` (also under every `deckId:`-prefixed spelling —
  see below) and exports `areConfusableMeanings(a, b)` plus the test seam
  `indexConfusableGroups(artifact)`.
- `src/domain/session/choices.ts` — pool building factored into
  `tieredDistractorPool` (shared by the Effect and sync variants) with three
  tiers: same-POS non-confusable, other non-confusable, confusable last.
  `generateChoicesLenientEffect`'s catch-all iterates non-confusable keys
  first. Public signatures and error semantics untouched.
- `tests/domain/confusables.test.ts` — new, 11 tests.
- `designs/confusable_distractors.md` — decision note (§1 artifact/predicate,
  §2 tiering, §3 degradation), referenced from the code comments.

## Public contracts used/added

- Consumes the fixed artifact contract:
  `{ schemaVersion: 1, groups: [{ id, meaningKeys }] }`; confusable iff two
  keys share a group; keys are raw compiled `meaningKey` values.
- Added exports: `areConfusableMeanings`, `indexConfusableGroups` (the latter
  is also how tests install synthetic groups; the shipped file's contents are
  never assumed by tests).

## Commands run and results

```text
npm test        # typecheck + validate:cards + validate:curriculum
                # + unit: 35 files / 321 tests pass;
                # 1 pre-existing environmental failure:
                # tests/import-decks/archive-sqlite.test.ts needs the
                # git-ignored local decks/*.apkg sources (decks/ absent
                # on this machine) — unrelated to this change.
npx vitest run tests/domain/confusables.test.ts   # 11 pass
```

## Key semantics (for the next agent)

1. Confusability **demotes, never excludes**. `generateChoices` fails with
   `insufficient-distractors` below eight choices; the third tier is what
   keeps starved pools filling. Do not "simplify" the tiers into a filter.
2. Review Mode's merged deck namespaces meaning keys (`hsk-1:to talk`), so
   the index registers both spellings at load time. If the artifact ever
   ships namespaced keys instead, the raw registration covers it; nothing
   needs to change.
3. The empty artifact must remain a byte-identical no-op — the third tier
   draws no RNG when empty, which is what keeps `(deck, word, seed)`
   deterministic across the feature's rollout. The golden test pins this.
4. Data pipeline (companion task): fill `src/shared/data/confusable-meanings.json`
   with real groups. When it lands, only tests that install synthetic groups
   are affected; the shipped suite reads the real file everywhere else.

## Known limitations / follow-ups

- The artifact is shipped empty today (`groups: []`), so runtime behaviour
  is unchanged until the pipeline's data lands.
- The part-of-speech preference test in `tests/domain/choices.test.ts`
  (ratio > 0.8 over the corpus) counts tier-3 distractors as their label's
  POS; if the pipeline ships very many confusable groups, that ratio can
  drift down. Re-check when the data lands.
