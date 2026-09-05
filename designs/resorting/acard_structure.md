# `.acard` sources and the authored curriculum

The repository has three deliberately separate layers:

1. `.acard` files are reviewable source records, kept in official HSK-grade
   directories;
2. `cards/curriculum.json` is the committed fixed-lesson manifest;
3. `public/game-data/hsk-*/deck.json` is compiled runtime data.

## Source card contract

Each `acard/1` file contains one logical word:

```json
{
  "schema": "acard/1",
  "id": "24-hex-stable-word-id",
  "hanzi": "你好",
  "pinyin": "nǐhǎo",
  "meaning": "hello",
  "pos": "interjection",
  "senseLabel": null,
  "audio": "content-sha256.mp3",
  "level": 1,
  "curriculum": {
    "components": ["你", "好"],
    "frequency": {
      "rank": 1234,
      "source": "opensubtitles-2018-zh-cn",
      "tier": "common"
    },
    "grade": 1,
    "notes": null,
    "pin": null,
    "topics": ["social-interaction"]
  },
  "source": {
    "deck": "source deck name",
    "guids": ["source-guid"],
    "overrides": [],
    "sharedId": 123
  }
}
```

`id` is a stable semantic identity and the filename is only a human-readable
locator. Homographs use pinyin and, when necessary, an ID suffix. The
validator re-derives IDs, components, filenames, audio hashes, and source
ledger hashes.

`level` is immutable official HSK provenance. `curriculum.grade` is runtime
placement after prerequisite hoisting and must be less than or equal to
`level`. Moving a card at runtime never moves its source file.

There are no curriculum seed or bound-morpheme exemption fields. All existing
component cards participate in the same prerequisite rules.

## Curriculum metadata ownership

The APKG extractor owns semantic/source fields and derives the candidate
substring list in `curriculum.components`. The sorter owns frequency, effective
grade, topic assignment, and lesson placement. A non-null pin requires a
review note and can only change base priority; it cannot override dependencies.

Frequency ranks come from the pinned OpenSubtitles corpus. Topic IDs must exist
in `cards/topics.json`. Reading exceptions live in
`cards/prerequisite-overrides.json` with a reason, so generation fails rather
than hiding an unreviewed exception in code.

## Committed manifest

`cards/curriculum.json` contains:

```text
schemaVersion
generator { name, version, rulesVersion }
lessonSize = 20
levels[]
  deckId, hskLevel, cardCount
  lessons[]
    id
    cards[] { id, file, hanzi, prerequisiteIds }
```

Every source file occurs exactly once. A lesson has at most 20 cards. Every
prerequisite is either in an earlier effective grade or an earlier lesson of
the same grade. Array order is the authored order; consumers must not sort or
shuffle it.

`cards/curriculum.lock.json` records input and output hashes. Both files use
stable JSON with a trailing newline and are checked byte-for-byte by
`npm run validate:curriculum`.

## Runtime deck contract

The deck compiler loads every source card, groups it by `curriculum.grade`,
and embeds the relevant manifest as:

```ts
type RuntimeCurriculum = {
  rulesVersion: string;
  lessonSize: 20;
  lessons: Array<{ id: string; wordIds: string[] }>;
};
```

The compiled deck's words, audio, meaning indexes, distractor indexes, counts,
and stroke-data inputs all follow effective grade placement. The demo deck
uses the same runtime lesson shape.

## Learn Mode and saves

`curriculumOrder(deck)` only flattens and validates the runtime manifest. It
has no RNG or seed input.

A Learn session always includes every due introduced card. New cards are
limited to the unintroduced remainder of the current authored lesson and to
the configured 5–20 cap. A five-card setting therefore completes one authored
lesson over four sessions; unused capacity never reaches into the next
lesson. Session membership is persisted and resumes exactly. The displayed
lesson number uses the fixed 20-card curriculum, not the configurable cap.

Save schema v5 has no `LevelProgress.curriculumSeed`. Earlier save schemas are
rejected and start a fresh profile; there is intentionally no migration or
repair path.

## Generation sequence

```bash
npm run import:acards       # only when source APKG content changes
npm run sort:curriculum     # update metadata, manifest, and lock
npm run import:decks        # compile effective runtime decks and audio
npm run import:strokes -- --source /path/to/graphics.txt
npm test
npm run build
```

Normally a curriculum-only edit starts at `sort:curriculum`. Generated
`public/game-data` is ignored; the source cards, curriculum manifest/lock, and
trimmed stroke bundles are committed.
