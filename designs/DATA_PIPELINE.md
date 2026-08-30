# Anki deck import and runtime data design

## 1. Source inventory

The six requested packages are downloaded under [`../decks/`](../decks/README.md), total roughly 508 MiB. They are immutable inputs.

| Deck | Shared ID | Source notes | Cards | Source word audio | Expected logical words after exact dedupe |
|---|---:|---:|---:|---:|---:|
| HSK 1 | 1623336797 | 300 | 900 | 300 | 300 |
| HSK 2 | 1488171715 | 200 | 600 | 200 | 200 |
| HSK 3 | 1074787074 | 500 | 1,500 | 500 | 500 |
| HSK 4 | 562028400 | 1,000 | 2,998 | 1,000 | 1,000 |
| HSK 5 | 345498902 | 1,601 | 4,803 | 1,601 | 1,600 |
| HSK 6 | 395921696 | 1,800 | 5,400 | 1,800 | 1,798 |

All packages contain a readable SQLite `collection.anki21`, a `media` JSON mapping, and the same ten-field note model:

```text
Hanzi | Pinyin | Part of Speech | Meaning | SentenceHanzi |
SentencePinyin | SentenceMeaning | AudioHanzi | AudioSentence | Image
```

All 5,401 `AudioHanzi` values are well-formed `[sound:filename.mp3]` references and resolve through their package's media map.

Cards and Anki scheduling metadata are deliberately ignored. The game creates its own per-logical-word progress.

## 2. Why import at build time

The browser should not parse a 508 MiB collection of ZIP and SQLite files. A TypeScript import command turns each selected source into one compact JSON deck plus only its word audio:

```text
decks/hsk-1-1623336797.apkg
  │
  ├─ collection.anki21 ──> notes ──> normalize/dedupe/index ──> deck.json
  └─ media + numbered ZIP entries ──> selected AudioHanzi ────> audio/*.mp3
```

Generated output is disposable and gitignored:

```text
public/game-data/
├── index.json
├── import-report.json
├── hsk-1/
│   ├── deck.json
│   └── audio/<content-sha256>.mp3
└── ... hsk-2 through hsk-6
```

Run it with `npm run import:decks`. `npm run dev`, `npm run build`, and CI should fail with a useful instruction if generated data is absent or stale.

## 3. Import implementation

Use Node/TypeScript under `tools/import-decks/`:

- `yauzl` or another lazy/streaming ZIP reader;
- `better-sqlite3` for the temporarily extracted database;
- shared Zod schemas for final output;
- Node `crypto` for package, content, and logical-word hashes;
- a deterministic stable JSON serializer.

Do not load an entire APKG into memory. A package can exceed 140 MiB and contain thousands of unused images and sentence-audio files.

### Two-pass archive flow

1. Verify archive SHA-256 against `decks/SHA256SUMS`.
2. First ZIP pass: extract only `collection.anki21` and `media` to an OS temporary directory.
3. Read notes from SQLite in `notes.id` order and parse `flds` by unit separator (`\x1f`).
4. Parse the media map and collect required numbered ZIP members for `AudioHanzi`.
5. Normalize notes and merge exact semantic duplicates.
6. Choose one deterministic primary word audio for a merged logical word.
7. Second ZIP pass: stream only selected numbered media entries, validate MP3 magic/type, hash content, and copy to a temporary output directory.
8. Build indexes and validate the complete `RuntimeDeck`.
9. Atomically rename the temporary generated deck directory into place.
10. Emit a report; always delete temporary files in `finally`.

Never execute card templates, embedded HTML, JavaScript, or media. SQLite is opened read-only.

## 4. Runtime schemas

Names are illustrative but the semantic fields are required.

```ts
type DeckId = "hsk-1" | "hsk-2" | "hsk-3" | "hsk-4" | "hsk-5" | "hsk-6";

type RuntimeWord = {
  id: string;                     // stable logical hash, not an array position
  sourceGuids: string[];          // all merged Anki note GUIDs
  displayHanzi: string;           // NFKC, metadata removed, CJK validation passed
  hanziKey: string;               // normalized key used by distractor exclusion
  displayPinyin: string;          // original toned form, sanitized
  acceptedPinyin: string[];       // canonical ASCII forms, e.g. ["nver"]
  partOfSpeech: string | null;     // HTML removed and whitespace normalized
  partOfSpeechKey: string | null;
  senseLabel: string | null;       // source “verb”, “classifier”, or “sense 2” suffix
  meaning: string;                // full sanitized source meaning
  meaningKey: string;             // normalized unique-label key
  example: {
    hanzi: string;
    pinyin: string;
    meaning: string;
  } | null;
  audioUrl: string;               // relative local generated URL
};

type MeaningIndexEntry = {
  label: string;
  wordIds: string[];
  hanziKeys: string[];
  partOfSpeechKeys: string[];
};

type RuntimeDeck = {
  schemaVersion: 1;
  importerVersion: string;
  id: DeckId;
  hskLevel: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  fingerprint: string;            // source package hash + schema/importer version
  source: {
    sharedId: number;
    url: string;
    packageSha256: string;
    sourceNoteCount: number;
    logicalWordCount: number;
  };
  words: RuntimeWord[];            // sorted by stable ID
  meaningIndex: Record<string, MeaningIndexEntry>;
  meaningKeysByPartOfSpeech: Record<string, string[]>;
  allMeaningKeys: string[];
};
```

This directly satisfies the need for an ergonomic hash from meanings back to Hanzi/words. At runtime, seven distractors are selected from precomputed key arrays without scanning the deck.

Do not use word-array indexes as save IDs. An importer update or source reorder must not attach old mastery to a different word.

## 5. Stable IDs and deduplication

### Source identity

Preserve every Anki `notes.guid`. A logical ID is a versioned hash over normalized semantic identity:

```text
sha256("word-v1\0" + displayHanzi + "\0" + displayPinyin + "\0" + meaningKey)
```

Use the first 24 lowercase hexadecimal characters in JSON; collision detection still compares the full hash during import and fails if a prefix collision occurs.

### Merge only exact semantic duplicates

Merge notes only when these are equal after sanitization:

- `displayHanzi`;
- toned `displayPinyin` (not tone-stripped accepted pinyin);
- `meaningKey`.

Union source GUIDs and choose the earliest source note's metadata/audio deterministically. This produces:

- HSK 5: two identical `看 / kān / to look after, to watch` notes → one logical word;
- HSK 6: duplicate `局 / jú / measure word for games, sets` → one logical word;
- HSK 6: duplicate `料 / liào / material` → one logical word.

Do **not** merge homographs or tone-distinct senses. Examples include HSK 2 `过` and HSK 4 `空`. They intentionally remain separate learning records. After pinyin succeeds, toned pinyin and part of speech/sense metadata help disambiguate their meaning stage.

## 6. Hanzi normalization and source corrections

### Mechanical normalization

For every source Hanzi:

1. decode as Unicode and apply `NFKC`;
2. trim surrounding whitespace;
3. remove one accidental trailing period;
4. parse a terminal parenthetical qualifier, e.g. `本 (classifier)` or `生 (verb)`, into `senseLabel`;
5. parse a terminal source sense number `1` or `2` after a CJK character into `senseLabel`;
6. validate that `displayHanzi` contains only allowed CJK ideographs plus an explicit small allowlist (`〇`, middle dot if later encountered).

NFKC is important: source values such as `⼋`, `⽩⾊`, and `爱⼈` use Kangxi/CJK compatibility forms and should display as ordinary `八`, `白色`, and `爱人`.

Never globally remove arbitrary Latin text. Unexpected residue is a blocking audit error.

### Explicit override file

`tools/import-decks/overrides.json` is keyed by source GUID. It records reviewed corrections with a reason and original value. Initial required correction:

```json
{
  "official-2026-V}>OiO&8T-1779527161486": {
    "displayHanzi": "劳动",
    "reason": "Source Hanzi is '劳verb'; pinyin, meaning, and sentence identify 劳动."
  }
}
```

A correction changes display/semantic output but never the source `.apkg`. The import report lists all applied overrides.

### Known visible metadata

The audit found 23 source Hanzi values containing spaces, punctuation, sense numbers, or Latin qualifiers before normalization. These are expected only when handled by the rules/override above. Any new instance after a source update must block import for review.

## 7. Text and HTML sanitization

Anki fields are data, not trusted UI markup.

- Decode HTML entities (`&#x27;`, `&amp;`, etc.).
- Convert `<br>` to a space or separator in part of speech.
- Strip all other tags with a well-tested parser, not a broad browser `innerHTML` assignment.
- Normalize Unicode to NFKC for keys and NFC for display text.
- Collapse repeated whitespace.
- Preserve full meaning text, including comma/semicolon-separated senses; do not arbitrarily choose only the first gloss.
- Never render imported strings with React `dangerouslySetInnerHTML`.

Some meanings are about 120 characters. The UI must wrap them; the importer must not truncate them.

Meaning keys use case-folded, punctuation/whitespace-normalized text. Two labels with the same meaning key cannot both appear in one choice set.

## 8. Pinyin canonicalization

Split source alternatives on `/` before canonicalizing; `shéi/shuí` yields two accepted forms.

Canonicalization algorithm:

```text
canonicalizePinyin(input)
  NFKC + lowercase + trim
  normalize u: to v
  NFD into base-letter clusters
  if cluster is u + diaeresis, emit v
  otherwise emit the base letter and discard tone combining marks
  discard spaces, hyphens, apostrophes, punctuation
  retain only ASCII a-z and v
```

Important: do not strip all combining marks before handling diaeresis, or `nǚ` incorrectly becomes `nu` instead of `nv`.

Apply the same function to imported forms and player submissions. Deduplicate accepted forms and fail a note if none remain.

Tone-insensitive pinyin can collapse distinct deck entries (`guò` and neutral `guo` both become `guo`). This is acceptable because they remain different spawned words; toned pinyin and sense metadata are revealed before their separate meaning questions.

## 9. Audio processing

Use only `AudioHanzi` for MVP.

1. Parse exactly one `[sound:filename]` token; report malformed values.
2. Resolve filename to its numbered APKG member through `media` JSON.
3. Reject path traversal and unexpected archive paths.
4. Stream and hash bytes.
5. Validate supported local format (the audited fields use `.mp3`).
6. Write to `audio/<content-sha256>.mp3`; identical bytes may share one asset.
7. Put only relative URLs in runtime JSON.

Do not extract images or `AudioSentence`; this substantially reduces generated size. Preserve example sentence text because it is useful in correction/summary UI at negligible cost.

The client unlocks audio on the user's initial Deploy action, preloads the active target's word audio, plays it after pinyin success, and handles failures as UI warnings only. Audio failures never mark a learning answer wrong.

## 10. Meaning indexes and distractor safety

Build these at import time:

- `meaningIndex[meaningKey]` — display label plus reverse `wordIds`, `hanziKeys`, and POS keys;
- `meaningKeysByPartOfSpeech[posKey]` — sorted unique candidates;
- `allMeaningKeys` — sorted unique global candidates.

For every logical word, importer validation should simulate candidate filtering and assert at least seven unique distractor keys remain after excluding:

- its own meaning key;
- all entries associated with the same `hanziKey`;
- duplicate normalized labels.

All six decks are large enough. A deck with fewer than eight safe meanings is invalid for this game mode.

## 11. Determinism and staleness

Given the same source bytes, override file, schema version, and importer version, generated JSON/audio names must be identical.

- Sort words by ID and every index array lexicographically.
- Exclude current timestamps and machine paths.
- Use stable JSON object ordering.
- Include source and override hashes in `fingerprint`.
- Generate into a temporary sibling directory and atomically replace only after validation.

`public/game-data/index.json` records each fingerprint. A save whose deck fingerprint differs is migrated by matching stable word IDs; unmatched old records are archived under `orphanedProgress`, and new words receive initial progress. The player sees a migration summary before play.

## 12. Import report and blocking checks

`import-report.json` contains per deck:

- package/checksum status;
- source note/card/media counts;
- logical count and exact duplicate groups;
- applied overrides;
- NFKC-changed values;
- parsed sense labels;
- missing/blank fields;
- malformed and missing audio;
- pinyin alternatives/canonical collisions;
- maximum meaning lengths;
- distractor pool validation;
- output byte totals and fingerprint.

Block output on checksum mismatch, unreadable SQLite, wrong note model/field count, empty core fields, unresolved audio, invalid Hanzi after reviewed normalization, empty accepted pinyin, stable-ID collision, fewer than eight safe choices, or schema failure. Warnings alone are allowed for blank part of speech/image and canonical pinyin collisions.
