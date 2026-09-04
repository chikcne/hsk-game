# `.acard` files and the deterministic curriculum order

Status: **proposal / plan**. Nothing in this document is implemented yet.
Scope: the on-disk source format that replaces the `.apkg` packages as the
authoritative card store, and the JSON manifest that fixes the order in which
those cards are served to the player.

> **Constraint: no migrations, no datafixes.** The game is not in production
> and the only save file has been deleted deliberately so this work can start
> from a clean slate. Nothing here may carry existing progress forward:
> no save migration, no reconciliation fixture, no compatibility shim for an
> older `deck.json`, no cursor-repair pass. Where a section below would
> otherwise have described one, it says so and stops. If a change would break
> a save, the answer is that there is no save to break.



## 1. Why

### 1.1 The order is currently random

`src/domain/learning/curriculum.ts` orders every grade's words by an FNV-1a
hash of `curriculumVersion \0 curriculumSeed \0 deckFingerprint \0 wordId`. It
is *reproducible* (same seed → same order) but not *deliberate*: HSK 1 can open
with `亚洲`-grade obscurities before `你`, and a compound can arrive many
sessions before the single character it is built from. The player experience we
want is an authored progression: high-frequency survival vocabulary, then
coherent topic blocks, with components always taught before the compounds that
contain them.

To author an order we need a stable, reviewable, per-card home for the metadata
that drives it (frequency rank, topic, component links). A 2 MB generated
`deck.json` blob is not that home — it is generated output and gitignored.

### 1.2 The `.apkg` inputs are fragile

`decks/*.apkg` is 508 MiB, gitignored, and pinned only by
`decks/SHA256SUMS`. As of this writing **`decks/hsk-1-1623336797.apkg` is
already corrupt** — the file on disk is a 1 959-byte copy of
`decks/README.md`, and its SHA-256 (`37bd6b55…`) does not match the recorded
`797cee5a…`. `npm run import:decks` therefore cannot currently rebuild HSK 1;
the only surviving copy of that grade's 300 words is the generated,
gitignored `public/game-data/hsk-1/deck.json`.

That is the whole argument for this change. The vocabulary is small, textual,
and precious; it belongs in version control as reviewable text, not in a
half-gigabyte of unversioned binary ZIPs that nothing can regenerate.

### 1.3 Corrections have nowhere to live

`tools/import-decks/overrides.json` patches source data by Anki GUID
(currently one entry, for `劳动`). Every future correction — a bad gloss, a
missing sense label, a topic tag, a hand-placed ordering exception — has to be
expressed as a diff against an opaque binary. With `.acard` files a correction
is an ordinary edit to an ordinary file, reviewed in an ordinary diff.

## 2. Pipeline: before and after

Today:

```
decks/hsk-N.apkg  ──[npm run import:decks]──>  public/game-data/hsk-N/{deck.json,audio/*.mp3}
   (508 MiB, gitignored, one file corrupt)          (gitignored, generated)
```

Proposed:

```
decks/hsk-N.apkg ──[npm run import:acards]──> cards/hsk-N/*.acard  ─┐
   (archival, run once, then optional)          (5 398 text files,  │
                                                  git-tracked)      │
                                              cards/audio/*.mp3 ────┤
                                                  (61 MiB, tracked) │
                                                                    ├─[npm run import:decks]─> public/game-data/
                                              cards/curriculum.json ┘        (gitignored, generated, unchanged contract)
                                                  (the authored order)
```

Two commands, two very different cadences:

- **`npm run import:acards`** — the *extraction* step. Run once now, and again
  only if we ever take a new upstream deck release. Reads the `.apkg`
  packages exactly as `tools/import-decks` does today (checksum → ZIP →
  SQLite → normalize → dedupe) and writes one `.acard` per logical word plus
  the audio blobs. It **never overwrites human edits**: see §7.3.
- **`npm run import:decks`** — the *compile* step, rewritten to read
  `cards/` instead of `decks/`. Emits the same `public/game-data/` runtime
  contract the client already consumes, plus the curriculum order. No `.apkg`,
  no ZIP reader, no SQLite in the normal build path; it becomes a fast pure
  text-to-JSON compile.

After the extraction step has been run and committed, the `.apkg` files are no
longer required to build or play the game. Keep them archived off-repo if
convenient; nothing in CI or `npm run dev` will touch them.

## 3. Directory layout

```
cards/
├── README.md                  provenance, licence, how to edit
├── curriculum.json            THE ordered manifest (§6)
├── curriculum.lock.json       generator inputs + digests (§7.4)
├── audio/
│   ├── 00bf67d1….mp3          content-addressed, immutable, 5 125 files / 47 MiB
│   └── MANIFEST.json          sha256 → {bytes, sourceDecks, sourceGuids}
├── hsk-1/
│   ├── 你.acard
│   ├── 你好.acard
│   ├── 谢谢.acard
│   └── …                      300 files
├── hsk-2/  …                  200 files
├── hsk-3/  …                  500 files
├── hsk-4/  …                1 000 files
├── hsk-5/  …                1 600 files
└── hsk-6/  …                1 798 files
```

Cards stay bucketed by HSK grade, as required: the grade is the unit the
player selects on the title screen, the unit `LevelProgress` is keyed by, and
the unit a directory listing should make obvious.

### 3.1 File naming

Names must be stable (a rename is a delete + add in most review tools and
would churn `curriculum.json`), unique, and human-scannable.

```
<displayHanzi>.acard                                  default
<displayHanzi>__<acceptedPinyin>.acard                on homograph collision
<displayHanzi>__<acceptedPinyin>__<id[0:8]>.acard     on residual collision
```

The word's Hanzi is the name because that is how a human looks for a card. 62
Hanzi strings occur more than once in the corpus (`两` liǎng "two" in HSK 1 vs
the vehicle measure word in HSK 4; `好` hǎo vs hào; `只` zhī vs zhǐ), so the
first tier is not injective on its own. Collisions are resolved by appending
the canonical ASCII pinyin, and — only if that still collides, as with the two
`看 / kān` HSK 5 notes that dedupe to one word anyway — the first eight
characters of the stable ID.

Notes:

- The two colliding senses of a Hanzi are frequently in **different** grade
  directories, so most of the 62 need no suffix at all; the suffix rule is
  applied per directory, then globally verified.
- Filenames are NFC UTF-8. CJK ideographs have no canonical decomposition, so
  the macOS NFD-normalising filesystems do not perturb them. NFKC has already
  folded the Kangxi radical forms (`⼋` → `八`) during extraction, so no
  compatibility ideograph reaches a filename.
- The extraction step asserts that every generated name matches
  `^[\p{Script=Han}〇]+(__[a-z]+(__[0-9a-f]{8})?)?\.acard$` and that the set of
  names is unique case-insensitively (for Windows/macOS checkouts).

**The filename is not an identifier.** `curriculum.json` and every save file
reference the card's `id`. A rename is therefore always safe as long as the
`id` inside the file is untouched.

## 4. The `.acard` format

### 4.1 Why JSON

An `.acard` is a **UTF-8 JSON object**, pretty-printed with two-space
indentation, sorted keys, LF endings, one trailing newline, and **no `\u`
escaping of CJK** — the Hanzi must be readable in a diff.

Considered and rejected:

| Format | Why not |
|---|---|
| YAML | New runtime dependency; indentation-sensitive multi-line glosses; `是`-style values and unquoted strings invite type-coercion surprises. |
| TOML | New dependency; awkward for the nested `example` object; no clear win over JSON. |
| Markdown + front matter | Two parsers instead of one, and the payload is structured data, not prose. |
| One TSV/JSONL per grade | Cheaper to parse but loses the per-card diff, per-card review, and per-card blame that motivate the change. |

JSON needs no dependency, the repo already has a stable serializer
(`tools/import-decks/compile/stable-json.ts`), and the existing Zod schemas in
`src/shared/schemas.ts` extend to it directly. The `.acard` extension (rather
than `.json`) keeps editors, `git grep`, and glob patterns able to address
exactly these files.

### 4.2 Authored vs derived

The single most important rule of the format:

> **An `.acard` stores semantic content. It never stores anything the compiler
> can recompute.**

| Recomputed at compile time, absent from the file | Why |
|---|---|
| `hanziKey` | NFKC fold of `hanzi`. |
| `meaningKey` | Case/punctuation fold of `meaning`. Drift here silently breaks distractor exclusion. |
| `acceptedPinyin` | `canonicalizePinyin(pinyin)`, split on `/`. |
| `partOfSpeechKey` | Fold of `pos`. |
| `meaningIndex`, `meaningKeysByPartOfSpeech`, `allMeaningKeys` | Whole-deck indexes; per-card storage is impossible. |
| `fingerprint` | Whole-deck digest. |

`id` is the deliberate exception: it *is* derived
(`sha256("word-v1\0" + hanzi + "\0" + pinyin + "\0" + meaningKey)[0:24]`) but is
stored anyway, because it is the key every save file and the manifest point
at. The compiler **re-derives it and fails loudly on mismatch**, which turns
"a typo fix silently repoints a word's identity" into a build error. That
matters even with no saves in existence: the id is what `curriculum.json` and
every future save key on, and an id that drifts on an unrelated edit is a bug
whether or not anyone is currently holding a reference to it. Deliberately changing a gloss is then an explicit
two-line diff: the gloss and the `id`, with the consequence visible in review.

### 4.3 Fields

```jsonc
{
  "schema": "acard/1",

  // ── identity ────────────────────────────────────────────────────────────
  "id": "0f2b9c1d4e6a8b0c2d4e6f81",   // stable 24-hex logical hash; see §4.2
  "level": 1,                          // official HSK grade from the source deck
                                       // effective grade after hoisting is curriculum.grade

  // ── content (authoritative, human-editable) ─────────────────────────────
  "hanzi": "谢谢",
  "pinyin": "xièxie",                  // toned display form; "/" separates variants
  "pos": "verb",                       // nullable
  "senseLabel": null,                  // "classifier", "sense 2", … ; nullable
  "meaning": "to thank, thanks",
  "example": {                          // nullable
    "hanzi": "谢谢你的帮助。",
    "pinyin": "Xièxie nǐ de bāngzhù.",
    "meaning": "Thank you for your help."
  },

  // ── audio ───────────────────────────────────────────────────────────────
  "audio": "b3d1…64hex.mp3",           // filename in cards/audio/; nullable

  // ── curriculum metadata (drives the order; see §5) ──────────────────────
  "curriculum": {
    "boundMorpheme": false,            // true = exempt from rule 3 (D9)
    "grade": 1,                        // effective grade; <= level, see §11 Q1
    "frequency": { "rank": 41, "source": "…", "tier": "core" },
    "topics": ["social-interaction"],
    "components": ["谢"],              // in-corpus single-char words inside `hanzi`
    "pin": null,                        // hand-forced absolute position, normally null
    "notes": null                       // free text explaining any manual override
  },

  // ── provenance (written by extraction, never hand-edited) ───────────────
  "source": {
    "deck": "hsk-1-1623336797",
    "sharedId": 1623336797,
    "guids": ["official-2026-H&FjiD.SlH-1779527158883"],
    "overrides": []                     // reviewed corrections applied at extraction
  }
}
```

Field-by-field contract:

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema` | `"acard/1"` | yes | Bumped only on a breaking format change. |
| `id` | 24 lowercase hex | yes | Immutable identity. Save files key on it. |
| `level` | 1–6 | yes | The **official** HSK grade from the source deck. Immutable. |
| `hanzi` | string | yes | NFC. Han ideographs plus the `〇` allowlist only. |
| `pinyin` | string | yes | Toned display form. `shéi/shuí` keeps both. |
| `pos` | string \| null | yes | `、`-joined when the source lists several. |
| `senseLabel` | string \| null | yes | Disambiguates the 62 homograph groups in the UI. |
| `meaning` | string | yes | Full gloss, never truncated (longest is ~120 chars). |
| `example` | object \| null | yes | All three sub-fields required when present. |
| `audio` | string \| null | yes | Must exist in `cards/audio/`. Every one of the 5 398 words currently has audio; the type stays nullable for hand-authored cards. |
| `curriculum` | object | yes | §5. Present but may be all-null before the sort lands. |
| `source` | object | yes | Extraction provenance. Hand-editing it is a review smell. |

Unknown keys are a **hard error**, not a warning: a typo'd key that silently
does nothing is exactly the failure this format exists to prevent.

### 4.4 Worked example

`cards/hsk-1/谢谢.acard`, complete and to scale:

```json
{
  "audio": "d4e91b0c37a5f2681e0d4c9a5b7e3f01c2a4d6e8f0a2c4e6081a3c5e7092b4d6.mp3",
  "curriculum": {
    "boundMorpheme": false,
    "components": ["谢"],
    "frequency": { "rank": 91, "source": "opensubtitles-2018-zh-cn", "tier": "core" },
    "grade": 1,
    "notes": null,
    "pin": null,
    "seed": true,
    "topics": ["social-interaction"]
  },
  "example": {
    "hanzi": "谢谢你的帮助。",
    "meaning": "Thank you for your help.",
    "pinyin": "Xièxie nǐ de bāngzhù."
  },
  "hanzi": "谢谢",
  "id": "0f2b9c1d4e6a8b0c2d4e6f81",
  "level": 1,
  "meaning": "to thank, thanks",
  "pinyin": "xièxie",
  "pos": "verb",
  "schema": "acard/1",
  "senseLabel": null,
  "source": {
    "deck": "hsk-1-1623336797",
    "guids": ["official-2026-H&FjiD.SlH-1779527158883"],
    "overrides": [],
    "sharedId": 1623336797
  }
}
```

Keys are alphabetical because the serializer sorts them; that is what makes
two independent extractions byte-identical.

## 5. The `curriculum` block

This block exists so the ordering script has per-card inputs that a human can
read, argue with, and override. The final ordering rules themselves are the
subject of a separate document; the format only has to carry their inputs.

- **`frequency.rank`** — integer, 1 = most common, or `null` if the corpus does
  not cover the word. `frequency.source` names the pinned corpus so a later
  corpus swap is a visible diff. `frequency.tier` is the coarse bucket the
  sorter actually uses (`core` / `common` / `mid` / `tail`), so that a small
  wobble in the underlying rank never reshuffles a lesson.
- **`topics`** — ordered array of topic ids from a single controlled
  vocabulary defined in `cards/topics.json`; the first entry is the primary
  topic and is what the sorter groups on. Unknown ids fail validation.
- **`components`** — the in-corpus single-character words that occur inside a
  multi-character `hanzi`. Derived, but stored, because it is the input to the
  "component before compound" constraint and reviewers need to see it. The
  compiler recomputes and diffs it.
- **`boundMorpheme`** — `true` on the 47 cards exempt from rule 3 (decision D9
  in `sorting_rules.md`): the 39 already marked `suffix` / `prefix` /
  `auxiliary` / `助` / `后缀` in the source data, plus 红 黑 白 认 超 同 公 气.
  An exempt card is never hoisted and never becomes a prerequisite, so its
  compounds are taught whole. Materialised as a flag rather than recomputed
  from POS, so the list is visible in review.
- **`pin`** — the escape hatch: `{"before": "<id>"}` / `{"after": "<id>"}` /
  `{"index": <n>}` to force a placement the rules get wrong. Every non-null
  `pin` requires a non-null `notes`, enforced by validation, so no unexplained
  hand-placement survives review.

## 6. `cards/curriculum.json` — the ordered manifest

The manifest is **materialised output that is committed**. The ordering script
computes it from the `.acard` metadata; the committed file is what the build
reads. A rule change therefore shows up as a reviewable reordering diff rather
than as an invisible behaviour change — which is the entire point of making the
order deterministic.

```jsonc
{
  "schemaVersion": 1,
  "generator": { "name": "sort-curriculum", "version": "1.0.0", "rulesVersion": "order-v1" },
  "topicsFile": "topics.json",
  "levels": [
    {
      "deckId": "hsk-1",
      "hskLevel": 1,
      "cardCount": 300,
      "sections": [
        {
          "id": "hsk-1-core",
          "title": "Everyday essentials",
          "kind": "frequency",
          "topic": null,
          "cards": [
            { "id": "…", "file": "hsk-1/你.acard",   "hanzi": "你" },
            { "id": "…", "file": "hsk-1/好.acard",   "hanzi": "好" },
            { "id": "…", "file": "hsk-1/你好.acard", "hanzi": "你好" },
            { "id": "…", "file": "hsk-1/谢谢.acard", "hanzi": "谢谢" }
          ]
        },
        {
          "id": "hsk-1-family",
          "title": "Family",
          "kind": "topic",
          "topic": "family-and-people",
          "cards": [ … ]
        }
      ]
    }
  ]
}
```

Design decisions:

- **The order is explicit, not a rule set the client re-evaluates.** The client
  and the domain layer read a list. This is the difference between "the order
  is deterministic" and "the order is reproducible if every machine agrees on
  the tie-break of a float comparison".
- **Cards carry `id`, `file`, and `hanzi`.** `id` is load-bearing; `file` lets
  the compiler resolve without scanning; `hanzi` is redundant and exists purely
  so the diff of a reorder is readable by a human. Validation asserts all three
  agree.
- **Sections are annotation, not chunking.** Learn Mode draws
  `settings.levelSize` new words per session (a 5–100 slider), so lesson
  boundaries cannot be the unit of introduction without breaking that setting.
  Sections give the UI something to name ("Family, 12 of 34") and give the
  ordering script its grouping unit; the session still slices `levelSize`
  entries from `curriculumCursor`. *(Open question 6 revisits this.)*
- **Every card of a grade appears exactly once**, and the union across grades
  is exactly the 5 398 `.acard` files. Validation is a set-equality check, not
  a count.

`curriculum.lock.json` records the digest of every input the generator
consumed (each `.acard`'s `curriculum` block, `topics.json`, the frequency
corpus checksum, the rules version) so CI can prove the committed manifest is
the one those inputs produce.

## 7. Determinism, identity, and safety

### 7.1 The compile step must stay byte-reproducible

Same `cards/` tree → byte-identical `public/game-data/`. Concretely: sorted
keys, no timestamps, no absolute paths, `\n` endings. This is already true of
the existing importer and must survive the rewrite.

One trap: `tools/import-decks/compile/stable-json.ts:11` sorts object keys but
**preserves array order**. That is exactly what we need — the curriculum order
must be an *array*, and it must be the one array in the output that is not
sorted by a content key. Storing the order as an object keyed by position
would have it silently re-sorted lexicographically (`"10"` before `"2"`).

### 7.2 What happens to `fingerprint`

`RuntimeDeck.fingerprint` is currently
`sha256("deck-v1\0" + IMPORTER_VERSION + "\0" + packageSha256 + "\0" + overrideSha256)`
(`tools/import-decks/compile/compiler.ts:124`). Because it hashes the `.apkg`
bytes, it cannot survive the removal of the packages. After the migration it
hashes the **`cards/` inputs** instead: the sorted list of
`(id, hanzi, pinyin, meaning, audio)` tuples, the schema version, and the
importer version.

That is a new value, and normally the consequence would be a reconciliation
pass over every existing save. **There are no existing saves.** So:

- no reconciliation fixture, no `retained/added/removed` assertion against a
  pre-migration save, no `orphanedProgress` audit;
- the reconciliation code path in `src/domain/learning/reconcile.ts` is not
  being deleted — it still earns its keep for *future* deck edits once people
  are actually playing — but nothing in this work needs to exercise it, and no
  test needs to prove it handles the `.acard` cutover;
- the fingerprint may change as many times as it likes during implementation.
  It is not a compatibility surface right now.

The `curriculum` block and `curriculum.json` stay **out** of the fingerprint
anyway, on design grounds rather than migration grounds: re-sorting the lessons
is not a change to the deck's content, and coupling the two would mean every
reorder discarded the grade's active `LearnSession` (`launch.ts:53`) and
tripped the server's session/level fingerprint check
(`src/server/saves/validation.ts:138-139`) once there *are* saves to protect.

One thing worth keeping regardless: today the fingerprint is an input to the
order hash (`curriculum.ts:25-26`), so any fingerprint change reshuffles a
player's remaining words. The authored order deletes that coupling outright.

### 7.3 Extraction must never clobber an edit

`npm run import:acards` is destructive by nature and will be run rarely,
against a tree that by then contains human corrections. It therefore:

1. defaults to `--dry-run`, printing a per-file `create` / `update` / `identical`
   / **`conflict`** plan;
2. classifies as `conflict` any card whose on-disk content differs from what
   the last extraction wrote (tracked by a digest in
   `cards/audio/MANIFEST.json`'s sibling `cards/.extraction.json`) — i.e. any
   file a human has touched;
3. refuses to write conflicts without `--force`, and lists them;
4. never touches the `curriculum` block of an existing file: extraction owns
   `id`/content/`source`, the sorter owns `curriculum`, and the two write
   disjoint key sets.

### 7.4 Validation (blocking)

`npm run validate:cards`, run by CI and as the compile step's first phase:

- every `.acard` parses, matches the Zod schema, and has no unknown keys;
- `id` re-derives from `(hanzi, pinyin, meaningKey)`;
- `level` matches the parent directory;
- filename matches the §3.1 rule and is globally unique;
- `hanzi` contains only permitted code points; no Latin residue;
- `canonicalizePinyin` yields at least one accepted form (`nǚ` → `nv`, not `nu`);
- `audio` resolves to an existing file in `cards/audio/` whose name equals its
  own SHA-256 and whose bytes are a valid MP3;
- `topics` entries all exist in `topics.json`; a non-null `pin` has `notes`;
- `components` matches the recomputation;
- per grade, every word retains ≥ 7 safe distractor meanings after excluding
  its own `meaningKey` and every entry sharing its `hanziKey` (the existing
  rule, unchanged);
- `curriculum.json` covers each grade's card set exactly once, references only
  existing files, agrees on `id`/`hanzi`, and satisfies the ordering invariants
  (§8);
- `curriculum.lock.json` matches the inputs.

Any failure exits non-zero. Warnings only for: null `audio`, null `pos`, null
`frequency.rank`, and canonical-pinyin collisions between distinct words.

## 8. Ordering invariants the manifest must satisfy

Stated here because they are properties of the *file*, verifiable without
knowing the rules that produced it. The rules themselves live in the sorting
document.

1. **Coverage** — each grade's manifest is a permutation of that grade's cards.
2. **Component-before-compound** — for any card whose `curriculum.components`
   is non-empty, every listed component that is a card *in the same grade*
   appears earlier. Violations must be explicitly listed in an
   `allowedInversions` array with a reason, and the validator fails on any
   unlisted one.
   *Measured today: 3 134 multi-character words have all their component
   single-character words at the same or an earlier grade; 643 have a component
   whose standalone card lives at a **later** grade (`中国` in HSK 1 needs `中`,
   which is an HSK 3 card); 540 contain no character that is a standalone card
   at all. The 643 cross-grade cases cannot satisfy the rule while cards stay
   bucketed by grade — see open question 1.*
3. **Monotone frequency tier within a section** — a section never places a
   `tail`-tier card before a `core`-tier one.
4. **Stability** — re-running the generator on unchanged inputs reproduces the
   manifest byte-for-byte, and changing one card's metadata perturbs only its
   own neighbourhood, never the whole grade. (Achieved by sorting on
   `(tier, topic, rank, hanzi, id)` — an explicit total order with no
   hash-derived tie-break.)

## 9. Runtime and domain impact

Verified against the current tree, not assumed.

### 9.1 The ordering swap is remarkably small

`curriculumOrder` has exactly **one** real runtime consumer:
`src/domain/learn/session.ts:37`, `const order = curriculumOrder(deck, level.curriculumSeed)`,
whose result is walked to split due words from new words (lines 40–48).
Everything else is re-export plumbing (`learning/progress.ts:3,57` —
whose "exposed for callers that need the full order, e.g. audio preloading"
comment is stale, there is no such caller — and the `learning/index.ts:3`
barrel). Replacing the hash sort with a manifest lookup is a one-line change
at the call site.

`LevelProgress.curriculumSeed` becomes vestigial. It is written by
`learning/progress.ts:16,35` from `launch.ts:25-26,56`, seeded by
`App.tsx:78-82 secureCurriculumSeed()`, and read in exactly the one place
above. With no saves to preserve, **delete it outright** rather than leaving a
reserved field nobody writes: drop it from `LevelProgressSchema`
(`schemas.ts:78`), from `CreateLevelOptions` (`learning/progress.ts:16,35`),
from `PrepareLearnLaunchOptions.newLevelSeed` (`launch.ts:25-26,56`), and
delete `secureCurriculumSeed()` (`App.tsx:78-82`) and its call site at
`App.tsx:180`. Eight test files construct it and will need the field removed:
`tests/domain/{learn,learning,relearn,workload}.test.ts`,
`tests/client/{learn-screen,relearn-screen}.test.tsx`,
`tests/integration/runtime.test.ts`, `tests/server/helpers.ts`.

A dead field that five call sites still thread through is exactly the kind of
debris that becomes permanent once real saves exist. This is the window to
remove it.

`curriculumCursor` keeps its exact meaning (an index into the now-authored
order) and all its consumers keep working unchanged: the lesson number
(`learning/progress.ts:52`, shown by `LearnScreen.tsx:147` and
`App.tsx:449`), the START/CONTINUE label (`App.tsx:23`), the invariants
(`learning/invariants.ts:43-44,53-54`), and the server's equality check
against the introduced count (`server/saves/validation.ts:120-127`).

### 9.2 Runtime loading must stay bundled — this is a hard constraint

There is one deck fetcher, `loadRuntimeDeck` at `src/client/app/App.tsx:53-64`,
and it fetches `/game-data/${id}/deck.json`. Nothing in the client ever fetches
`index.json` (only the importer's own `checkGeneratedData` reads it).

Learn loads one grade lazily (`App.tsx:177`), but **Review and Relearn load all
six decks eagerly** — `Promise.all(DECK_IDS.map(...))` at `App.tsx:220` and
`App.tsx:279`. Shipping the 5 398 `.acard` files to the browser as-is would
turn one request into ~5 400. It is not an option, and it is not the proposal:
`.acard` is a *source* format, the compile step keeps emitting the bundled
`deck.json` the client already fetches. Nothing about the client's network
behaviour changes.

`src/client/data/reviewDeck.ts:24-101` reinforces this. It merges all six
loaded decks into one synthetic cross-grade deck and needs every source deck's
`meaningIndex`, `meaningKeysByPartOfSpeech`, and `allMeaningKeys` to build
distractor pools (lines 36-56) — `generateChoices` throws outright when the
pool is too small. Those whole-deck indexes cannot be assembled from per-card
files at runtime, only at compile time.

### 9.3 Schema changes

Neither `RuntimeWordSchema` nor `RuntimeDeckSchema` uses `.strict()`, so an
added key parses today and is merely stripped from the inferred type. That
staged-rollout property is not needed here — there is no deployed client to
stay compatible with — so the order payload can be added to the schema and the
generator in the same commit, and made **required** rather than optional.
Proposed additions:

- `RuntimeDeck.curriculum: { rulesVersion: string; sections: Section[] }`,
  where a `Section` is `{ id, title, topic, wordIds: string[] }`. The flat
  order is the concatenation of `sections[].wordIds`. Sections cost a few KB
  and unlock "Family — 12 of 34" in the Learn HUD; a bare `string[]` is the
  cheaper alternative if that UI is not wanted.
- `RuntimeWord.topics: string[]` — required, for the same UI. (Required is
  affordable precisely because nothing older has to parse it; the cost is that
  the `RuntimeDeck` literals in `tests/client/review-deck.test.ts:38-116` and
  `tests/import-decks/compile.test.ts:68-73` must all gain the field.)

`LearningDeck` (`domain/learning/types.ts:4`) is
`Pick<RuntimeDeck,"id"|"fingerprint"> & { words: ReadonlyArray<Pick<RuntimeWord,"id">> }`.
It must grow the order too, since `session.ts` is its only consumer of
ordering. Keeping it a `Pick` of `RuntimeDeck` preserves the nice property
that the domain layer needs almost nothing from the deck.

### 9.4 Other readers of the compiled output

Three non-client consumers parse `deck.json` and must keep working:
`src/server/saves/manifests.ts:22` (builds the `DeckCatalog` of
`{ fingerprint, wordIds }` used by save validation — note its `fingerprint`
is stored but never actually compared, only `wordIds` is used),
`tools/import-strokes/extract.ts:174-181` (`loadGeneratedDecks`, full
`RuntimeDeckSchema.parse` of all six), and the importer's own
`checkGeneratedData` (`compiler.ts:229-268`), which hardcodes
`deckUrl === "${id}/deck.json"` at line 255 and the
`/^audio\/[a-f0-9]{64}\.mp3$/` shape at line 263.

`src/client/data/demoDeck.ts:17-32` — the bundled 40-word fallback used only
when a grade has no persisted level — needs an order as well, or must
explicitly declare "source order is the curriculum order". It is also imported
by `tools/import-strokes/extract.ts:8` and four test files.

### 9.5 Tests that must change

Two existing assertions *directly contradict* an authored order and are the
canary for this whole change — `tests/domain/learning.test.ts:42-43`:

```ts
expect(order).not.toEqual(source.words.map((w) => w.id)); // "actually shuffled"
expect(curriculumOrder(source, "other-seed")).not.toEqual(order);
```

Both must be rewritten: the new contract is that the order equals the
manifest and is *seed-independent*. The same file's `:62` and `:80` use
`curriculumOrder(...)[0]` to pick "the first word".

Also affected:

- `tests/domain/choices.test.ts:9-12` reads all six real
  `public/game-data/*/deck.json` from disk and **hard-fails if they are
  absent** — it is the de-facto guard that the compile step still produces
  them, and should stay exactly as it is.
- `tests/import-decks/compile.test.ts:50-73` round-trips
  `RuntimeDeckSchema.parse` against an inline literal (new required fields
  break it), `:82-85` pins the `stableJson` key-sort/array-order contract, and
  `:87-102` proves a failed compile leaves the previous `public/game-data`
  untouched.
- `tests/client/review-deck.test.ts:38-116` builds `RuntimeDeck` literals —
  any new *required* schema field breaks all of them, which argues for making
  the order payload optional in the schema and required in validation.
- `tests/import-strokes/extract.test.ts:96-103` reads `deck.json` but is
  `existsSync`-guarded, so it degrades silently rather than failing.
- Cursor/ordinal fixtures that must keep passing unchanged:
  `tests/domain/learn.test.ts:52-108,372-429`, `tests/domain/workload.test.ts:37,100,121-122`,
  `tests/server/saves.test.ts:163-188`, `tests/server/helpers.ts:14-28`,
  `tests/client/learn-screen.test.tsx:110-116`.

### 9.6 Docs that go stale

`designs/DATA_PIPELINE.md` (the whole of §2–§5 and §11),
`designs/LEARNING_AND_SAVES.md:54,60-61,114-117,195-199,300-301,311`,
`designs/MAIN.md:90`, `designs/TEST_PLAN.md:124`,
`designs/STROKE_ORDER_RENDERING.md:158`, `designs/AGENT_WORK.md:188`, and
`README.md:90`. `DATA_PIPELINE.md` should be updated in the same PR rather
than left to contradict this one.

## 10. Implementation plan

1. Land `tools/import-acards/` and run it against the five intact packages.
2. **Recover HSK 1** — its `.apkg` is corrupt (§1.2). Rebuild those 300 cards
   from the surviving `public/game-data/hsk-1/deck.json`, which is a complete
   record of the extraction, and note the provenance in each card's `source`
   block. Re-download the package to verify against `SHA256SUMS` if AnkiWeb
   still serves it.
3. Commit `cards/` — 5 398 text files plus 47 MiB of audio (cross-grade
   deduplication takes the 5 320 generated blobs down to 5 125 unique ones). Audio is
   content-addressed and immutable, so it compresses and delta-packs well and
   will never be rewritten; plain git is acceptable, Git LFS is the
   alternative if the clone size is judged unacceptable (open question 3).
4. Land `validate:cards` and wire it into `npm test`.
5. Rewrite `import:decks` to compile from `cards/`; assert its output is
   byte-identical to today's `public/game-data/` **except** for `fingerprint`
   and the new order payload. That byte-comparison is the proof the rewrite is
   lossless — it compares generated output against generated output, and needs
   no save data at all.
6. Land the topic vocabulary, the frequency data, and the sorter; commit the
   first `curriculum.json`.
7. Switch `curriculumOrder` to the manifest (one line in
   `domain/learn/session.ts:37`), rewrite the two contradicting assertions in
   `tests/domain/learning.test.ts:42-43`, and delete `curriculumSeed` and its
   eight test fixtures (§9.1).

Steps 1–5 are a pure refactor with a mechanical correctness proof — the output
must be byte-identical except for `fingerprint` — and can land before any
sorting decision is made. Steps 6–7 are the behaviour change, and they touch
one call site.

**Not in this plan, deliberately:** no save migration, no reconciliation
fixture, no `orphanedProgress` handling, no cursor repair, no compatibility
shim for the current `deck.json` shape, and no dual-read period. The save file
was deleted so this could be a clean cutover, and every step above is verified
against generated output rather than against player data. The first run after
the switch starts every grade from an empty `LevelProgress`, which is the
intended outcome, not a regression to be papered over.

## 11. Open questions

1. **Cross-grade components — DECIDED: hoist.** Components are hoisted into
   the earlier grade so rule 3 holds absolutely (decision D3 in
   `sorting_rules.md`), with 47 bound morphemes exempt (D9). This moves 304
   cards and grows HSK 1 from 300 to 355. Format consequence: an `.acard` must carry **both** its official
   `level` (from the source deck, immutable) and its effective
   `curriculum.grade` (after hoisting). The directory a card lives in follows
   `curriculum.grade`, since that is the grade the player will meet it in, and
   the validator asserts `curriculum.grade <= level` with the pulling compound
   named as the reason.
2. **1,621 compounds contain no standalone-card character at all**, so the
   rule is simply silent on them. Confirm that is fine.
3. **Audio in git**: plain git (simple, 47 MiB clone) or Git LFS (small clone,
   extra tooling)? Recommend plain git — the blobs are immutable, so the repo
   grows once and never again.
4. ~~**Re-sorting and in-flight players.**~~ **Dropped — no migrations.**
   There are no in-flight players and no saved cursors, so the cursor-repair
   pass this question proposed is not being built. Worth revisiting the first
   time the order is re-sorted after real players exist; recorded here only so
   the omission is deliberate rather than forgotten.
5. **Missing audio.** All 5 398 words have audio today, so the validator could
   simply *block* on `"audio": null` and keep the corpus complete. That would
   forbid adding a hand-authored card without recording it first. Recommend
   nullable + warning, but say if you would rather it be a hard requirement.
6. **Sections vs. hard lesson boundaries.** Recommended above that
   `settings.levelSize` keeps slicing the flat order and sections are only
   labels. The alternative — sessions snap to section boundaries — gives
   tidier lessons but makes the slider advisory. Which do you want?
7. **Does `senseLabel` need to become richer** now that homographs sit adjacent
   in an authored order? Two `看` cards next to each other need to be
   distinguishable at a glance.
