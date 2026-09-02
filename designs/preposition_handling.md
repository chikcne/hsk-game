# Meaning-choice hotkeys: preposition and scaffolding handling

Audit of `src/domain/session/choices.ts` against the complete compiled deck corpus
(`public/game-data/hsk-{1..6}/deck.json`: 5,398 words, 4,996 distinct meaning labels — the
full HSK 1–6 Anki content, `DECK_TOTALS` accounted for exactly).

The `"to like"` fix (special-casing `like` after infinitive `to`) resolved one instance of a
much wider pattern. This document lists the remaining instances, ranked by how likely each is
to mislead a player, each with real corpus evidence.

## How the numbers here were produced

Every figure below comes from driving the real exported functions — `choiceShortcutsForLabel`
and `generateChoices` — over every label and every word in the six compiled decks, not from a
reimplementation. Round-level figures simulate `generateChoices` with the same seed shape the
client uses (`enemy.id`, see `src/client/state/useBattle.ts:265`).

## What is already correct

Two things worth recording so they are not re-investigated:

- **Highlight indices are exact.** For all 4,998 labels, `label[shortcut.index]` matches
  `shortcut.key` case-insensitively — 0 mismatches. The `offset += gloss.length + 1`
  accounting and the `split("/", 1)` variant handling never drift, so `<mark>` in
  `src/client/app/App.tsx:427` always lands on the intended letter.
- **No round can fail to fill.** 32,388 simulated draws (every word × 6 seeds) produced 0
  `Not enough meanings with non-colliding shortcuts` throws. The corpus currently has enough
  key diversity, and per-round load is modest: median 11 distinct live hotkeys, p95 14, max 18
  of 26.

Everything below is about *which* letter is chosen, not whether the machinery works.

---

## 1. Parenthetical usage notes are parsed as glosses and get their own hotkeys

`choiceShortcutsForLabel` splits on `[;,]` with no awareness of `(` / `)`. Register notes,
grammar notes and example objects inside parentheses therefore become "glosses" and claim
letters. 110 labels have at least one hotkey anchored inside parentheses.

The worst cases are the ones where the parenthetical is *not a meaning at all*:

| Label | Keys | Junk anchor |
|---|---|---|
| `here (formal; southern china)` | `H` `S` | `S` on "southern" |
| `there (formal; Southern China; written Mandarin)` | `T` `S` `W` | `S` on "Southern", `W` on "written" |
| `here (informal; northern China)` | `H` `N` | `N` on "northern" |
| `it (object, animals)` | `I` `A` | `A` on "animals" |
| `they (for object, animals)` | `T` `A` | `A` on "animals" |
| `Sunday (formal; written Chinese)` | `S` `W` | `W` on "written" |
| `to listen (the action of hearing; ongoing activity)` | `L` `O` | `O` on "ongoing" |
| `to sleep (to attach specific details—like a duration of time, a direct object, or adjectives—directly to the verb.)` | `S` `D` `O` | `D` on "direct", `O` on "or" |
| `time, duration, hours/minutes. (talking about the abstract concept of time, clock time, or a span/amount of time)` | `T` `D` `H` `C` `O` | `C` on "clock", `O` on "or" |
| `with, by (used to introduce the object of a verb, similar to 把); will, shall, be about to` | `W` `U` `S` `B` | `U` on "used" |
| `to hold, to convene, to conduct (a ceremony, meeting, event)` | `H` `C` `C` `M` `E` | `M` on "meeting", `E` on "event" |
| `to lighten, to ease, to alleviate, to reduce (burden, weight, pressure)` | … `W` `P` | `W` on "weight", `P` on "pressure" |
| `to watch (TV, program)` | `W` `P` | `P` on "program" |
| `to take (medicine)` | `M` | **only** key is `M` on "medicine" — no key for "take" |
| `to give; (to, for)` | `G` `T` `F` | `T` on the bare preposition "to" |
| `to be called, to call; to make; (by)` | `C` `C` `M` `B` | `B` on "by" |

Two distinct harms:

1. **Wrong mnemonic.** Pressing `A` selects "it"; pressing `W` selects "Sunday". The mark makes
   it visible but the letter carries no meaning.
2. **Key theft.** `to sleep (…)` claims `S`, `D` and `O`, so no distractor keyed `D` or `O`
   can enter that round. Junk keys measurably narrow the distractor pool.

Note also that `here (…southern china)` and `there (…Southern China…)` both claim `S`, so they
can never appear together — see §5.

Also present: 3 labels use full-width parentheses (`（in vain, for nothing）` in hsk-4) which
the code ignores identically, so the same issue applies.

**Suggested handling:** strip `(...)` spans (both ASCII and full-width) before splitting into
glosses, or at minimum do not emit shortcuts for glosses that lie wholly inside parentheses.

## 2. Structural glosses anchor on the meta-word, which leaks the answer

125 labels anchor a hotkey on the literal word **"measure"** (`measure word for books` → `M`),
17 on **"suffix"**, 11 on **"particle"**, 9 on **"used"**, 4 on **"prefix"**, 3 on
**"auxiliary"**.

Because every `measure word for …` label carries `M`, `generateChoices` rejects all of them as
distractors for one another. Simulated over the whole corpus:

- **366 of 366 measure-word rounds (100%) contained exactly one `measure word for …` option.**
- 33 of 33 `suffix indicating …` rounds: same.
- 46 of 48 `particle …` rounds (95.8%): same.

A player who does not know 本 at all still answers correctly by picking the only option shaped
like a measure word. This is the single most consequential finding: the hotkey rule is silently
disabling a whole question category.

A secondary effect: within `measure word for pieces, chunks, money`, the enumerated nouns
become glosses, so `C` ("chunks") and `M` ("money") become hotkeys for things the word does not
mean. Same for `measure word for trees, plants, and other similar objects` → an `A` on "and".

**Suggested handling:** anchor structural glosses on the *counted noun* rather than on
"measure" (`measure word for books` → `B`), and do not split the enumeration after
`measure word for` into separate glosses. That both restores the mnemonic and lets measure
words compete as each other's distractors.

## 3. The particle set is incomplete, so identical constructions anchor inconsistently

`LEADING_PREPOSITIONS` contains `up`, `down`, `in`, `on`, `off`, `over`, `through`, `around`,
`along` — but **not** `out`, `back`, `away`, `forward`, `together`, `ahead`, `apart`. The same
phrasal-verb shape therefore anchors on the verb in one case and on the particle in another:

| Gloss | Key | Anchor | Why |
|---|---|---|---|
| `to go up` | `G` | go | `up` is in the preposition set |
| `to go down` | `G` | go | `down` is in the set |
| `to go through` | `G` | go | `through` is in the set |
| `to go out` | `O` | **out** | `out` is missing from the set |
| `to come in` | `C` | come | `in` is in the set |
| `to come out` | `O` | **out** | missing |
| `to come back` | `B` | **back** | missing |
| `to give up` | `G` | give | in the set |
| `to give back` | `B` | **back** | missing |
| `to look at` / `to look for` / `to look into` | `L` | look | in the set |
| `to look back` | `B` | **back** | missing |
| `to look forward to` | `F` | **forward** | missing |
| `to get up` | `G` | get | in the set |
| `to get off work` | `W` | work | `off` in set, `work` is content |
| `to keep away from` / `to stay away from` | `A` | **away** | missing |

Affected anchor counts: `out` 11 labels, `back` 12, `together` 8, `forward` 7, `away` 3,
`ahead` 1, `apart` 1.

The inconsistency cuts both ways and neither branch is good:

- Where the particle *is* in the set, every phrasal verb collapses onto the light verb:
  `to go up`, `to go down`, `to go in`, `to go over`, `to go by`, `to go through`, `to go to`,
  `to go around`, `to go beyond`, `to go along` are **all** `G`. So 上去 / 下去 / 进去 / 过去 can
  never be distractors for each other — exactly the discrimination a learner needs.
- Where it is missing, the key lands on a semantically empty particle and collides across
  unrelated verbs: `to go out`, `to come out` and `to take out` are all `O`, so 出去 vs 出来 —
  where the whole contrast is *go* vs *come* — can never co-occur either.

Worst single instance: **`to turn off device` and `to turn on device` are both `D`** (anchored
on "device"), so 关 and 开 can never appear in the same round, and neither key encodes the
distinction.

**Suggested handling:** decide the rule deliberately rather than by set membership. A phrasal
verb's discriminating element is usually the particle, so `to go out` → `O`, `to go up` → `U`,
`to come back` → `B` is defensible and internally consistent; `to turn off` → `O` vs
`to turn on` → `O` then needs a tiebreak, so the alternative (always anchor the verb, key the
particle only as a second shortcut) may be cleaner. Either way, the current split behaviour
should not stand.

## 4. Function words and placeholders chosen as anchors

Conjunctions, negators and placeholder nouns are in none of the three scaffolding sets, so they
win as "content words".

**Conjunctions (`and` 18 labels, `or` 11, `if` 12, `then` 13, `so` 13, `but` 11):**

- `inside and outside` → **`A`** on "and". 里外; should be `I`.
- `up and down, high and low` → **`A`** on "and", then `H`. Should be `U`.
- `to come and go` → **`A`** on "and". Should be `C` or `G`.
- `as well as, and` → `W` on "well", `A` on "and". 以及; neither is the head.
- `particle indicating suggestion, confirmation, or hesitation` → an `O` hotkey on "or".
- `then, or; (auxiliary particle)` → `A` on "auxiliary".

**Placeholders (`one` 14, `someone`/`something` 2, `oneself` 6):**

- `to do as one pleases` → **`O`** on "one"
- `as one pleases, casual` → **`O`** on "one"
- `in one breath, without a break` → **`O`** on "one"
- `in a row, one after another; repeatedly` → `R`, **`O`** on "one", `R`
- `to do something ahead of time` → **`S`** on "something"
- `to keep someone company` → **`S`** on "someone"
- `to go to someone's house` → **`S`** on "someone's"

**Negation (`not` 35 labels):** `to have nothing to do` → `N` on "nothing";
`to have nothing to do with` → `N`; `have not` → `N` on "not". Defensible for 不/没 where
"not" *is* the meaning, but not for the 无所事事 case.

**Degree adverbs stolen from the head:**

- `to take good care of` → **`G`** ("good") while `to take care of` → `C` ("care"). Two near
  identical glosses, unrelated keys.
- `to be generally recognized` → `G`; `to be greatly surprised` → `G`;
  `to be only concerned with` → `O`; `to have currently` → `C`; `to go so far as to` → `S`.

**Suggested handling:** add coordinating conjunctions (`and`, `or`, `nor`, `yet`) and
placeholders (`one`, `oneself`, `someone`, `something`, `somebody`, `sth`, `sb`, `each other`)
to the scaffolding sets, with the same all-scaffolding fallback so a bare `and, with` still
keys `A`. Leaving `not` as content is probably right; leaving degree adverbs as content is
probably not, but that list is open-ended and lower priority.

## 5. `"to like"` is not the only lexical use hidden inside the scaffolding sets

The special case at `choices.ts:47` only fires for `words[0] === "to" && words[1] === "like"`.
Direct siblings it does not cover:

- **`to be like`** (in 像 `to resemble, to be like; (as if, such as); (image, statue, portrait)`)
  → anchors `B` on "be". Same bug, one position further along. 像's primary key happens to be
  `R` from "resemble", so it is not fatal, but the `B` hotkey is meaningless and steals `B`.
- **`down jacket`** (羽绒服) → `J` on "jacket". Here "down" is a noun (feathers), not a
  preposition; the intuitive key is `D`.
- **`past years`** (往年) → `Y` on "years". "past" is the meaning-bearing adjective.
- **`above-mentioned`** (上述) → `M` on "mentioned". The regex splits on the hyphen, so `above`
  is skipped as a preposition. A player presses `A`.
- **`per capita`** → `C` on "capita", which is not a standalone English word. Player presses `P`.
- **`as if, seem`** → `I` on "if"; **`of course`** → `C`; **`over the years`** → `Y`;
  **`after all, after all`** → `A` `A` on "all".

**Suggested handling:** generalise rather than extend the one-off. A rule like *"if every word
in the gloss is scaffolding, or if the only non-scaffolding word is a bound/partial form, use
the first non-determiner word"* covers `to be like` and `per capita`. `down jacket`,
`past years` and `above-mentioned` need a small exception list (or a check that a preposition
followed by a noun with no intervening verb is attributive, not prepositional) — worth handling
because these are the labels a player will most confidently key wrongly.

## 6. Confusable pairs are systematically prevented from co-occurring

A consequence of §2–§4 rather than a separate bug, but the highest-value thing to fix, because
it removes the most instructive distractors. `generateChoices` rejects any distractor sharing a
key with anything already on screen, so labels that collapse to the same key are mutually
exclusive by construction:

| Pair | Shared key | Anchored on |
|---|---|---|
| `the day after tomorrow` / `the day before yesterday` | `D` | "day" |
| `the year after next` / `the year before last` | `Y` | "year" |
| `to turn on device` / `to turn off device` | `D` | "device" |
| `to go out` / `to come out` / `to take out` | `O` | "out" |
| `to come back` / `to go back` / `to give back` / `to look back` / `to turn back` | `B` | "back" |
| `to go up` / `to go down` / `to go in` / `to go over` / `to go through` | `G` | "go" |
| `here (formal; southern china)` / `there (formal; Southern China…)` | `S` | "Southern" |
| `it (object, animals)` / `they (for object, animals)` | `A` | "animals" |
| all 125 `measure word for …` labels | `M` | "measure" |
| `Chinese character` / `Chinese language` / `Chinese food, Chinese meal` / `Chinese chess` … (10 labels) | `C` | "Chinese" |

517 label pairs sharing a primary key have ≥0.6 token overlap. Fixing the anchoring rules in
§2–§4 dissolves most of these automatically.

## 7. Labels that claim too many keys

195 labels emit ≥4 shortcuts, 74 emit ≥5, 39 emit ≥6, maximum 9:

```
9  hsk-4  "light, rayl smooth, shiny, used up; bare, expose; only, merely, solely"  -> LRSUBEOMS
9  hsk-4  "to be certain, to be sure, to affirm; positive, affirmative, definite; surely, certainly, definitely"  -> CSAPADSCD
8  hsk-4  "to hand in, to submit; to meet, to cross; to make friends with; friend, acquaintance, relationship"  -> HSMCFFAR
8  hsk-5  "same, alike; to share, to be the same; together; with; and, as well as"  -> SASSTWAW
7  hsk-1  "correct, right; to, toward, for; (to treat; pair)"  -> CRTTFTP
```

A 9-key answer removes 9 of 26 letters from the round. 731 labels also emit *duplicate* keys
(`he, him` → `H` `H`; `not, no` → `N` `N`), which is harmless for input but marks several
letters in one label.

Also visible above: `"light, rayl smooth, …"` contains a source typo (`rayl`), which is a deck
data issue rather than a hotkey one, but it does anchor `R`.

**Suggested handling:** cap shortcuts per choice (2–3, taking the first distinct keys) and
dedupe. Reduces key theft and visual noise without changing which key is primary.

## 8. Two adjacent defects found while auditing

Both are outside the preposition rules but sit directly on this code path.

### 8a. Part-of-speech preference is destroyed by the shuffle

`choices.ts:82-90` builds `pool = [...new Set([...preferred, ...eligible])]` to front-load
same-part-of-speech distractors, then Fisher-Yates shuffles the **whole** pool, discarding the
ordering. Measured over the corpus: only **26.8%** of distractors (10,000 of 37,324) share the
target's part of speech, while an average of **342 same-POS meanings are available per word** —
far more than the 7 needed. The stated intent is not in effect; a noun answer routinely sits
among adverbs and particles.

Fix: shuffle `preferred` and `eligible` separately and concatenate, rather than shuffling the
union.

### 8b. The meaning-phase key listener ignores modifier keys

`src/client/app/App.tsx:347-360` reads `event.key.toUpperCase()` and, for any A–Z, calls
`preventDefault()` and `chooseMeaning()`. It never checks `ctrlKey` / `metaKey` / `altKey`.
During the meaning phase, **Ctrl+R / Cmd+R submits "R" as an answer and blocks the reload**;
the same applies to Cmd+F, Ctrl+S and similar. The deck-select listener at
`src/client/app/App.tsx:223-224` already guards on `altKey || ctrlKey || metaKey`; the battle
listener should match.

### 8c. Minor: no import-time guarantee of 8 non-colliding keys

`tools/import-decks/normalize/words.ts:156-158` asserts ≥7 *safe* distractors per word but not
that 8 non-colliding shortcut key sets exist. The corpus satisfies it today (0 failures in
32,388 draws), but a deck edit or a change to the anchoring rules could surface
`Not enough meanings with non-colliding shortcuts` as a mid-battle throw rather than an import
failure. Worth asserting at import time, especially before changing anchoring.

### 8d. Minor: same meaning, different keys depending on role

Two labels share a `meaningKey` but differ in punctuation, so the same gloss keys differently
depending on whether it is the answer or a distractor (the distractor label comes from
`meaningIndex[key].label`, chosen as `[...labels].sort()[0]`):

```
hsk-5  "like, as if"        -> L I     (index label)
hsk-5  "like, as; if"       -> L A I   (word.meaning for the other word)
hsk-5  "otherwise, or else" -> O E     vs  "otherwise; (or else)" -> O E
```

No in-round conflict, since same-`meaningKey` distractors are already filtered out. Recorded
only so the asymmetry is not mistaken for a bug later.

---

## Suggested order of work

1. **§2 measure words** — a whole question category is currently free to answer (366/366).
2. **§8b modifier keys** — one-line fix, currently breaks browser reload during play.
3. **§1 parentheses** — strip `(...)` before splitting; removes 110 labels' junk keys and
   several §6 collisions at once.
4. **§3 particles** — pick one consistent rule for phrasal verbs; fixes 关/开 and 出去/出来.
5. **§4 conjunctions and placeholders** — additive set changes, low risk.
6. **§8a POS shuffle** — small fix, meaningful distractor-quality gain.
7. **§5 residual lexical cases** — generalise the `to like` special case; the hyphen and
   attributive-preposition cases (`down jacket`, `past years`, `above-mentioned`) may warrant an
   explicit exception list.
8. **§7 key cap** and **§8c import assertion** — hardening, best done alongside 1–5.

Regression tests worth adding to `tests/domain/choices.test.ts` as each is fixed: the specific
labels tabulated above, plus the two corpus-level invariants that already hold (highlight index
matches key for every label; no `generateChoices` throw over the full corpus) so they are not
lost while the anchoring rules change.
