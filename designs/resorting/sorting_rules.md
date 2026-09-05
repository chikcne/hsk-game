# Frequency-led prerequisite curriculum

This document describes the curriculum implemented by `tools/sort-curriculum`.
The generated order is committed in `cards/curriculum.json`; Learn Mode does
not shuffle it or accept a curriculum seed.

## Goals

The order balances three requirements:

1. useful, frequent vocabulary appears early;
2. particles and broad grammar material do not crowd out the opening lessons;
3. every available component word is completed in an earlier fixed lesson
   than a compound that depends on it.

The third rule applies to single characters, shorter compounds, and forms that
were previously described as bound morphemes. There are no exemptions. If a
component has no standalone card with the matching reading, the containing
word is taught whole and no dependency is created.

## Pinned inputs

- all `cards/hsk-*/*.acard` files;
- `cards/topics.json`, the reviewed controlled topic vocabulary;
- `cards/prerequisite-overrides.json`, reviewed exceptions for readings that
  cannot be resolved automatically;
- the OpenSubtitles 2018 Simplified Chinese word-frequency list in
  `tools/import-frequency/zh_cn_full.txt`;
- the pinned `pinyin-pro` package and package lock;
- the rules version in `tools/sort-curriculum/types.ts`.

Corpus provenance, commit, checksum, and licensing are recorded beside the
vendored data in `tools/import-frequency/SOURCE.md` and `notices/`.

## Base order

The generator assigns each card an exact corpus rank (or `null`), a stable
frequency tier, and one primary topic. Chinese part-of-speech labels used by
HSK 6 are normalized before particles are identified.

Within each effective HSK grade the unscheduled base order is:

1. the 80 highest-frequency non-particle cards (four 20-card lessons);
2. the delayed particle/grammar block;
3. the remaining core/common-frequency cards;
4. the remaining topic blocks, ordered by mean member frequency.

Grammar topics are interleaved after every three content-topic blocks. Stable
ties use Hanzi and then the word ID. An explained pin can influence base
priority, but cannot violate prerequisite placement. There is no curated
opening seed and no special placement for 你好.

## Prerequisites and effective grades

Extraction records every existing shorter substring in
`curriculum.components`, including nested compounds. The sorter asks
`pinyin-pro` for the component's reading in the containing phrase and matches
the standalone homograph. Pinyin spelling is normalized; tone is retained to
distinguish readings such as 好 hǎo and 好 hào. A tone-insensitive fallback is
allowed only when all candidates represent one pronunciation (for contextual
tone sandhi). Duplicate sense cards with the same pronunciation resolve to the
earliest official-grade card, then stable ID.

When a prerequisite's official grade is later than its dependent's effective
grade, it is hoisted into the dependent grade. Hoisting repeats to a fixed
point so nested chains move together. The `.acard` remains in its official HSK
directory and retains `level`; runtime placement is `curriculum.grade`.

Examples enforced by the real-data tests include:

- 你 and 好 hǎo occur before 你好;
- 电 occurs before 电影, which occurs before 电影院;
- 们 remains a prerequisite for 我们;
- 好 hào does not satisfy 你好.

## Fixed lesson scheduler

Lessons contain at most 20 cards. For one effective grade, a card becomes
eligible only after all same-grade prerequisites have been assigned to an
earlier lesson. Prerequisites inherit the earliest base priority of every
transitive dependent so they are promoted near the words that need them.

Each scheduling choice is ordered by prerequisite urgency, base position,
Hanzi, and stable word ID. The scheduler fails on a dependency cycle. A
prerequisite in an earlier effective grade is already assumed known.

## Reproducibility and validation

`cards/curriculum.lock.json` hashes the frequency corpus, topic definitions,
override file, normalized card inputs, rules version, and final manifest.
Generation uses stable JSON. Validation regenerates both artifacts and
requires byte-for-byte equality.

Run:

```bash
npm run sort:curriculum
npm run validate:curriculum
```

Tests additionally verify unique coverage, the 20-card maximum, effective
grade hoisting, every earlier-lesson dependency, representative polyphones and
nested chains, and deterministic output across repeated generation.
