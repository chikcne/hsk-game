# `cards/` — the authoritative vocabulary source

One `.acard` file per logical word, bucketed by HSK grade, plus the
content-addressed word audio they reference. This directory — not
`decks/*.apkg` — is the source of truth the build compiles from.

Format, naming rules and field semantics: [`../designs/resorting/acard_structure.md`](../designs/resorting/acard_structure.md).
Ordering rules and the decisions behind them: [`../designs/resorting/sorting_rules.md`](../designs/resorting/sorting_rules.md).

```
cards/
├── .extraction.json     digest ledger; how re-extraction detects hand edits
├── audio/               5,125 content-addressed MP3s, 47 MiB
├── hsk-1/  300 cards
├── hsk-2/  200 cards
├── hsk-3/  500 cards
├── hsk-4/  1,000 cards
├── hsk-5/  1,600 cards
└── hsk-6/  1,798 cards
```

## Editing

An `.acard` is ordinary JSON and may be edited by hand. Two rules:

1. **Do not touch `id` casually.** It is a hash of `(hanzi, pinyin, meaningKey)`
   and the validator re-derives it. Changing a gloss therefore requires
   changing the id in the same commit — deliberately, and visibly in review.
2. **Keep the canonical formatting** (sorted keys, two-space indent, trailing
   newline, unescaped CJK). `npm run validate:cards` fails on anything else so
   that a later re-extraction produces a clean diff.

Run `npm run validate:cards` after editing; it is also part of `npm test`.
Add `--deep` to additionally hash every audio blob and re-run the
distractor-pool simulation (~25s).

## Regenerating from the source packages

```bash
npm run import:acards            # dry run, prints the plan
npm run import:acards -- --write # apply
```

Extraction owns `id`, the content fields and the `source` block; the sorter
owns the `curriculum` block. They write disjoint key sets, so re-extraction
carries an existing card's curriculum metadata forward untouched. A card whose
bytes differ from the digest in `.extraction.json` has been hand-edited and is
reported as a **conflict**; extraction refuses to overwrite it without
`--force`.

## Provenance

The cards derive from the six AnkiWeb packages listed in
[`../decks/README.md`](../decks/README.md), normalized by
`tools/import-acards/`. All six grades come from their verified `.apkg`.

HSK 6 did not, until 2026-09-05. The file at `decks/hsk-6-395921696.apkg` was a
byte-exact copy of the HSK 1 package, so HSK 6's cards were recovered from
`public/game-data/hsk-6/deck.json` — the output of an earlier extraction of the
genuine package — and each such card said so in `source.deck`. The real package
has since been re-downloaded and verified, and re-extraction from it changed
nothing but that provenance string: all 1,798 ids, content fields, guids and
audio digests were already identical. The recovery is therefore retired, and
`cards/` no longer depends on a generated, gitignored artifact.

The package's 1,800 notes yield 1,798 cards: 局 and 料 each carry two notes that
normalize to the same `(hanzi, pinyin, meaningKey)`, so each pair merges into
one card holding both guids.

## Licensing

The source decks are CC BY-NC-SA 4.0. **Example sentences are deliberately not
extracted**: the licence carves them out of even its non-commercial grant
("except for the sentences — for permission to reuse the sentences, please
contact the author of the original sentence deck"), so the uploader cannot
sublicense them. There is no `example` field in `acard/1`. See
`acard_structure.md` §4.3.
