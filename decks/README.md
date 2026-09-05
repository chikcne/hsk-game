# Source Anki decks

These are the six user-requested Anki shared decks, downloaded from AnkiWeb on
2026-08-29 (UTC). The `.apkg` files are the immutable importer inputs; game-ready
JSON and word audio will be generated elsewhere and should not modify these files.

| HSK | AnkiWeb shared ID | Source | Package | Source notes | Word-audio files |
|---:|---:|---|---|---:|---:|
| 1 | 1623336797 | <https://ankiweb.net/shared/info/1623336797> | `hsk-1-1623336797.apkg` | 300 | 300 |
| 2 | 1488171715 | <https://ankiweb.net/shared/info/1488171715> | `hsk-2-1488171715.apkg` | 200 | 200 |
| 3 | 1074787074 | <https://ankiweb.net/shared/info/1074787074> | `hsk-3-1074787074.apkg` | 500 | 500 |
| 4 | 562028400 | <https://ankiweb.net/shared/info/562028400> | `hsk-4-562028400.apkg` | 1,000 | 1,000 |
| 5 | 345498902 | <https://ankiweb.net/shared/info/345498902> | `hsk-5-345498902.apkg` | 1,601 | 1,601 |
| 6 | 395921696 | <https://ankiweb.net/shared/info/395921696> | `hsk-6-395921696.apkg` | 1,800 | 1,800 |

> **Superseded as the build input.** The build now compiles from
> [`../cards/`](../cards/README.md), not from these packages. They remain here
> as the archival origin and are needed only to re-run
> `npm run import:acards`.

## Package integrity, as of 2026-09-05

All six files verify against `SHA256SUMS`.

Two of them had been wrong, and both are now repaired. This is recorded because
it is not recoverable from the filenames or `SHA256SUMS` alone.

| File | State |
|---|---|
| `hsk-1-1623336797.apkg` | **Repaired.** Had been overwritten with a 1,959-byte copy of this README. Restored from the copy found under the HSK 6 filename. |
| `hsk-6-395921696.apkg` | **Restored.** Had held a byte-exact copy of the **HSK 1** package (300 notes, 爱 / 八 / 爸爸 / 吧). Re-downloaded from AnkiWeb shared deck 395921696 on 2026-09-05 (145,441,917 bytes, 1,800 notes) and verified against the `968b3f37…` entry. |
| the other four | Unchanged; verify as before. |

`sha256sum -c SHA256SUMS` now reports six OK.

> **Re-downloading from AnkiWeb.** The shared-deck page is client-rendered, so
> its URL serves no file. The package needs a short-lived token:
> `GET /svc/shared/item-info?sharedId=<id>` returns a protobuf whose
> `available.deck.download_key` is the `t` query parameter of
> `GET /svc/shared/download-deck/<id>?t=<key>`.

All six archives pass `unzip -t`.

## Import observations

All decks use the note model `HSK Deck (Hanzi, Pinyin, Sentence, Audio)` with
these fields:

1. `Hanzi`
2. `Pinyin`
3. `Part of Speech`
4. `Meaning`
5. `SentenceHanzi`
6. `SentencePinyin`
7. `SentenceMeaning`
8. `AudioHanzi`
9. `AudioSentence`
10. `Image`

The runtime importer should retain only the data needed by the game and extract
`AudioHanzi`; sentence audio and images are not needed for the first release.
Some source Hanzi use Unicode compatibility radicals or sense suffixes. The
normalization and audit policy is specified in `../designs/DATA_PIPELINE.md`.

## Repository size

The source packages total roughly 508 MiB, and several exceed GitHub's 100 MiB
per-file limit. Use Git LFS before pushing them to a host with that restriction.
Git LFS is not configured automatically here because it is not installed in this
environment.
