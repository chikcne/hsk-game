# Confusable distractors handoff

## Scope completed

Review Mode's meaning choices no longer offer a distractor the data pipeline
has marked confusable with the answer unless the pool starves. 说 ("to speak,
to say") can no longer be "answered" with 说话's "to talk" while eight honest
slots exist; the near-synonym becomes the last-resort tier instead of a
failure mode on small acquired pools. In practice no pool starves, so the
last-resort tier is unreached and the behaviour equals exclusion — see
`designs/confusable_distractors.md` §2a for the measurements.

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

1. Confusability **demotes, never excludes** — but know why. The third tier
   guards against a pool too small to fill eight choices, and no reachable
   pool is that small: `createReviewDeck` merges distractor pools from every
   loaded deck, and both call sites load all of `DECK_IDS`, so the pool is
   always the whole corpus. Measured over the real decks, tier 3 has never
   been consumed and a hard filter would never have failed
   (designs/confusable_distractors.md §2a). Keep the tiers anyway — an empty
   tier is free and the guard is cheap — but do not defend them with a
   starvation story, and do not treat the synthetic starved fixtures in
   `tests/domain/confusables.test.ts` as production deck shapes.
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

- The pipeline's data has landed: the artifact ships 393 groups, so the
  demotion is live. Its observable effect is confined to tiers one and two
  (confusables kept out of rounds that had eight honest slots); the third
  tier remains unexercised on real decks — see §2a.
- The part-of-speech preference test in `tests/domain/choices.test.ts`
  (ratio > 0.8 over the corpus) counts tier-3 distractors as their label's
  POS; if the pipeline ships very many confusable groups, that ratio can
  drift down. It still passes on the shipped groups.
- `tests/domain/confusables.test.ts` was renamed to say `hypotheticallyStarved*`
  where it used to say `starved*`, and `tests/domain/choices.test.ts` gained the
  two §2a invariant tests ("eight non-confusable distractor candidates on
  distinct keys", "never offers a confusable distractor"). Those two are the
  tripwire: if either fails, tier 3 has become load-bearing and §2a is stale.
