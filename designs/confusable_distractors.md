# Meaning choices: confusable distractors demoted, not excluded

Review Mode shows eight meaning choices per prompt word. Distractors come from
`generateChoicesEffect` / `generateChoices` in `src/domain/session/choices.ts`, whose only
eligibility rule was identity: a distractor could not be the answer's own `meaningKey`, nor a
meaning attached to the same hanzi. Similarity played no part, so for 说 ("to speak, to say")
the gloss "to talk" (from 说话, `meaningKey: "to talk"`) was a *legal* distractor —
indistinguishable from the right answer, punishing the player for knowing the
language. This note records what replaced that: a precomputed confusable-meanings index
consumed as a distractor **tier**, never a filter.

## 1. The artifact and the predicate

`src/shared/data/confusable-meanings.json` is owned by the data pipeline
(`schemaVersion: 1`):

```json
{ "schemaVersion": 1,
  "groups": [ { "id": "speak-say-talk", "meaningKeys": ["to speak to say", "to talk"] } ] }
```

Two meaning keys are confusable iff they share at least one group; a key may appear in several
groups. `meaningKeys` are raw compiled `RuntimeWord.meaningKey` values (the 说/说话 example
above is hsk-1's actual pair). `src/domain/session/confusables.ts` flattens the groups once at
module load into `meaningKey → Set<groupId>` and exposes one predicate,
`areConfusableMeanings(a, b)`: two Map lookups and a Set walk, no allocation, because it runs
inside the round-building filter on the battle loop's requestAnimationFrame thread.

**Namespaced spellings.** One thing the contract understates: Review Mode never sees raw
meaning keys. `createReviewDeck` (`src/client/data/reviewDeck.ts`) merges every loaded source
deck's distractor pools under grade-namespaced keys (`hsk-1:to talk`), and those namespaced
strings are what `deck.allMeaningKeys` and `word.meaningKey` hold at the battle loop's only
call site (`src/client/state/useBattle.ts`). An exact-match-only index would therefore have
been a silent no-op in exactly the mode this ships for. The indexer additionally registers
every key under each `DECK_IDS` prefix at load time, so both the raw and the namespaced
spelling resolve; the per-call lookup stays allocation-free. Confusability is a property of
the meaning, not the grade, so `hsk-3:to speak to say` vs `hsk-5:to talk` is also true.

## 2. Demotion, not exclusion — three tiers

The obvious fix — filter confusables out of the eligible pool — is wrong: `generateChoices`
fails with `insufficient-distractors` below eight choices, and a one-day acquired pool merged
from one grade can genuinely need every meaning it has. Exclusion would trade an unfair
distractor for a crashed round.

Confusability is instead the **last** tier of the existing preference order:

```ts
const pool = [
  ...shuffle(preferred.filter(notConfusable), next),   // same part of speech
  ...shuffle(rest.filter(notConfusable), next),        // everything else
  ...shuffle(eligible.filter(isConfusable), next),     // near-synonyms, last resort only
];
```

So "to talk" appears only when the deck cannot fill eight slots without it — where a hard
filter would have failed the round outright. The tiers are shuffled separately because
shuffling the union would discard the preferences the ordering exists to express (the same
argument as preposition_handling.md §8a); a one-element tier costs no RNG draws, so the added
tier is free when empty. The shared pool build lives in one helper,
`tieredDistractorPool`, used by both the Effect and sync variants of `generateChoices`;
`generateChoicesLenientEffect`'s catch-all (which iterates all meanings without a cap)
applies the same demotion by iterating non-confusable keys before confusable ones. All four
entry points (`generateChoicesEffect`, `generateChoices`, `generateChoicesLenientEffect`, and
through them `safeMeaningChoices*`) demote identically.

## 3. Degradation and the no-op guarantee

`safeMeaningChoicesEffect` must never throw, so the artifact can never be a crash vector:

- **Malformed shape** — wrong `schemaVersion`, non-array `groups`, non-object or keyless
  group entries, non-string meaning keys — contributes nothing to the index. The worst case
  is "no confusables", i.e. exactly the pre-change behaviour.
- **Empty `groups`** (the artifact's state while the data pipeline fills it) is a verified
  no-op: tiers one and two then equal the old two-tier pool, and the empty third tier draws
  no randomness, so `(deck, word, seed)` produces byte-identical output. This is pinned by a
  golden test against output captured from the pre-change implementation
  (`tests/domain/confusables.test.ts`, "byte-identical under an empty artifact"), and by
  the existing corpus-wide suite (every word of all six compiled decks × six seeds still
  fills; the part-of-speech preference ratio is unchanged).

Determinism is preserved: choice content is a pure function of (deck, word, seed, artifact
state), and the artifact changes only between builds.

## Rejected alternatives

- **Hard filter.** Turns a near-synonym into `insufficient-distractors` on small pools.
  Rejected — a failed round is worse than an imperfect distractor.
- **Single shuffled union with a comparison sort.** Would discard the part-of-speech
  preference and cost an O(n log n) comparator per round for no benefit over tiered shuffles.
- **Similarity computed on the fly (token overlap).** Needs the very anchoring heuristics
  preposition_handling.md §6 shows to be unreliable, on the hot path. The pipeline computes
  groups offline where the corpus can be eyeballed.

## Verification

`tests/domain/confusables.test.ts` covers, all against a **synthetic** group (the shipped
artifact's contents are the pipeline's and are never assumed): the predicate (group
membership, multi-group keys, namespaced spellings, malformed artifacts), the byte-identical
empty-artifact goldens, exclusion while eight non-confusable slots exist, the tier-3 rescue
on a starved strict pool, the lenient degrade path appending the confusable last, fixed-seed
determinism with Effect/sync parity, and demotion through a real `createReviewDeck` merge
(the namespaced path).
