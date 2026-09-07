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

Confusability is the **last** tier of the existing preference order rather than a filter on
the eligible pool. Read §2a before trusting the usual justification for that: the starvation
scenario it appeals to is **not reachable today**, and the third tier is dead weight held
against future deck-construction changes, not an active rescue.

The preference order:

```ts
const pool = [
  ...shuffle(preferred.filter(notConfusable), next),   // same part of speech
  ...shuffle(rest.filter(notConfusable), next),        // everything else
  ...shuffle(eligible.filter(isConfusable), next),     // near-synonyms, last resort only
];
```

So "to talk" appears only when the deck cannot fill eight slots without it. Tiers one and two
are where the feature does its observable work: they are what keeps the near-synonym out of
说's choices, and on every reachable input that effect is *indistinguishable from exclusion*
(§2a). The tiers are shuffled separately because shuffling the union would discard the
preferences the ordering exists to express (the same
argument as preposition_handling.md §8a); a one-element tier costs no RNG draws, so the added
tier is free when empty. The shared pool build lives in one helper,
`tieredDistractorPool`, used by both the Effect and sync variants of `generateChoices`;
`generateChoicesLenientEffect`'s catch-all (which iterates all meanings without a cap)
applies the same demotion by iterating non-confusable keys before confusable ones. All four
entry points (`generateChoicesEffect`, `generateChoices`, `generateChoicesLenientEffect`, and
through them `safeMeaningChoices*`) demote identically.

## 2a. The starvation scenario is unreachable — measured

The rationale above (and the first version of this note) claimed that "a one-day acquired pool
merged from one grade can genuinely need every meaning it has". That is false, and the tier-3
rescue it motivates has never once fired:

- `createReviewDeck` merges `meaningIndex` from **every loaded source deck**, not from the
  selected `wordKeys` — its own header comment says so. Acquired-pool size therefore has no
  effect on `deck.allMeaningKeys`.
- Both call sites (`src/client/app/App.tsx`, Review and Relearn) load all of `DECK_IDS`
  unconditionally before merging, so `allMeaningKeys.length` is always the full corpus (5,252
  keys at the time of writing). A single-grade or acquired-only distractor pool is not a state
  the app can construct.

Exhaustively comparing the shipped three-tier pool against a hard-filter variant — counting
tier-3 consumption and `insufficient-distractors` failures — gives zero of both, everywhere:

| Configuration | Rounds | Tier-3 consumed | Hard-filter failures |
|---|---|---|---|
| Each compiled deck standalone, all 5,398 words × 12 seeds | 64,776 | 0 | 0 |
| `createReviewDeck` with one grade loaded and a one-word acquired pool | 32,388 | 0 | 0 |
| Real merged deck (all six grades, as both call sites build it) | 32,388 | 0 | 0 |

The margin is not narrow. The worst-case word (要 "to want, to need") still has 5,227
non-confusable candidates against the 7 it needs; the largest group in the artifact has 12
members, so exclusion can remove at most 11 keys; the fewest distinct primary shortcut letters
available among non-confusables is 25, against 8 needed. The deepest the selection loop has
ever scanned into the pool is 108 entries, and tier 3 begins past entry 5,000.

**Why the tiers stay anyway.** Not because starvation is a live risk, but because an empty tier
costs nothing — it draws no RNG and changes no output (§3) — and it keeps the generator total
against a future call site that builds a distractor pool from acquired words alone, or an
artifact that ships a pathologically large group. That is cheap insurance, not a necessity.
`tests/domain/choices.test.ts` pins the actual invariant ("every word of every compiled deck
has eight non-confusable distractors with non-colliding keys"); that test failing is the signal
that tier 3 has stopped being decorative and this section needs revisiting.

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

`tests/domain/choices.test.ts` additionally pins the §2a invariant over the real merged Review
Mode deck: every word has at least eight non-confusable distractor candidates carrying at least
eight distinct shortcut keys, so the strict generator never depends on tier 3.

Determinism is preserved: choice content is a pure function of (deck, word, seed, artifact
state), and the artifact changes only between builds.

## Rejected alternatives

- **Hard filter.** Would turn a near-synonym into `insufficient-distractors` on a pool small
  enough to starve. Retained as a rejection on the principle that a failed round is worse than
  an imperfect distractor — but note that no reachable pool is that small (§2a), so on today's
  decks and call sites a hard filter would behave identically to the tiering. The choice
  between them is about future-proofing, not about present behaviour.
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
on a hypothetically starved strict pool (a deck shape no call site builds — see §2a), the
lenient degrade path appending the confusable last, fixed-seed
determinism with Effect/sync parity, and demotion through a real `createReviewDeck` merge
(the namespaced path).
