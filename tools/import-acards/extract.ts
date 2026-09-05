import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Data, Effect } from "effect";
import { DECK_SOURCES, type DeckSource } from "../import-decks/compile/compiler";
import { extractArchiveEssentialsEffect, readChecksumFileEffect, type ArchiveError } from "../import-decks/archive/zip";
import { readMediaMapEffect, type MediaError, type SoundReferenceError } from "../import-decks/archive/media";
import { AnkiDatabase, type CollectionError } from "../import-decks/sqlite/read-collection";
import { normalizeAndDedupeEffect, type CompiledWord, type Overrides, type WordImportError } from "../import-decks/normalize/words";
import type { HanziError } from "../import-decks/normalize/hanzi";
import { extractSelectedAudio, type AudioError } from "../import-decks/compile/audio";
import { stableJson } from "../import-decks/compile/stable-json";
import { Fs, type FsError } from "../shared/fs";
import { sha256File } from "../shared/hash";
import { ACARD_SCHEMA, AcardSchema, acardFilename, type Acard, type AcardCurriculum } from "../shared/acard";

export const EXTRACTOR_VERSION = "1.0.0";

/** Typed failure for `.acard` extraction. */
export class AcardExtractionError extends Data.TaggedError("AcardExtractionError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

export type ExtractError =
  | AcardExtractionError
  | FsError
  | ArchiveError
  | MediaError
  | SoundReferenceError
  | WordImportError
  | HanziError
  | AudioError
  | CollectionError;

/** Where a grade's words came from. Every grade is `apkg` except one recovered
 * with `--recover`, whose source package is unusable. */
export type SourceKind = "apkg" | "generated-deck-json";

export type PlanEntry = { path: string; action: "create" | "update" | "identical" | "conflict" };

export type ExtractionReport = {
  entries: PlanEntry[];
  audioAssets: number;
  audioBytes: number;
  byDeck: Array<{ id: string; words: number; from: SourceKind }>;
  wrote: boolean;
};

/** Digest ledger written alongside the cards. An `.acard` whose on-disk bytes
 * differ from the digest recorded here has been hand-edited, and extraction
 * refuses to overwrite it without `--force`. */
type ExtractionLedger = { extractorVersion: string; files: Record<string, string> };

const LEDGER_NAME = ".extraction.json";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Every in-corpus word contained inside `hanzi`: single characters that are
 * themselves cards, plus shorter multi-character words (不客气 contains 客气).
 * Decision D4 extends rule 3 to the latter. */
export function componentsOf(hanzi: string, corpus: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const character of hanzi) {
    if (character !== hanzi && corpus.has(character)) found.add(character);
  }
  for (let length = 2; length < hanzi.length; length += 1) {
    for (let start = 0; start + length <= hanzi.length; start += 1) {
      const candidate = hanzi.slice(start, start + length);
      if (candidate !== hanzi && corpus.has(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
}

/** A freshly extracted card carries an inert `curriculum` block: the sorter
 * owns every field in it except `components`, which extraction computes. */
function blankCurriculum(grade: 1 | 2 | 3 | 4 | 5 | 6, components: string[]): AcardCurriculum {
  return { boundMorpheme: false, components, frequency: null, grade, notes: null, pin: null, seed: false, topics: [] };
}

type DeckWords = {
  words: CompiledWord[];
  from: SourceKind;
  audioNameByFilename: Map<string, string>;
  audioBytes: number;
  audioAssets: number;
};

const readLedger = (cardsRoot: string): Effect.Effect<ExtractionLedger, FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const text = yield* fs.readTextFile(join(cardsRoot, LEDGER_NAME)).pipe(
      Effect.catchTag("FsError", (error) => (error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error))),
    );
    if (!text) return { extractorVersion: EXTRACTOR_VERSION, files: {} };
    const value = JSON.parse(text) as Partial<ExtractionLedger>;
    return { extractorVersion: value.extractorVersion ?? "", files: value.files ?? {} };
  });

const readFromPackage = (
  source: DeckSource,
  repositoryRoot: string,
  overrides: Overrides,
  expectedChecksum: string | undefined,
  audioRoot: string,
): Effect.Effect<DeckWords, ExtractError, Fs | AnkiDatabase> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* Fs;
      const apkgPath = join(repositoryRoot, "decks", source.filename);
      const actual = yield* sha256File(apkgPath).pipe(Effect.catchTag("FsError", () => Effect.succeed("")));
      if (!actual || (expectedChecksum && actual !== expectedChecksum)) {
        return yield* Effect.fail(new AcardExtractionError({
          detail: `${source.filename} is missing or fails its checksum (expected ${expectedChecksum ?? "?"}, got ${actual || "unreadable"}). ` +
            `Pass --recover ${source.id} to rebuild that grade from public/game-data/${source.id}/deck.json instead.`,
        }));
      }
      const extractionDirectory = yield* Effect.acquireRelease(
        fs.mkdtemp(join(tmpdir(), `hsk-acards-${source.id}-`)),
        (directory) => Effect.ignore(fs.rmRecursive(directory)),
      );
      const essentials = yield* extractArchiveEssentialsEffect(apkgPath, extractionDirectory);
      const database = yield* AnkiDatabase;
      const collection = yield* database.readCollection(essentials.collectionPath);
      const media = yield* readMediaMapEffect(essentials.mediaPath);
      const { words } = yield* normalizeAndDedupeEffect(collection.notes, media, overrides);
      const selected = new Map<string, string>();
      for (const word of words) {
        const member = media.memberByFilename.get(word.audioFilename);
        if (member) selected.set(word.audioFilename, member);
      }
      const audio = yield* extractSelectedAudio(apkgPath, selected, audioRoot);
      const audioNameByFilename = new Map<string, string>();
      for (const [filename, url] of audio.urlByFilename) audioNameByFilename.set(filename, url.split("/").pop()!);
      return { words, from: "apkg", audioNameByFilename, audioBytes: audio.totalBytes, audioAssets: audio.assetCount };
    }),
  );

/** Recovery path for a grade whose package is unusable. A generated
 * `deck.json` is the output of a successful earlier extraction of the same
 * package: it carries the already-normalized fields and the same stable ids,
 * and its `audio/` directory holds the same content-addressed MP3s. Nothing is
 * re-derived, so the recovered cards match what the intact package would have
 * produced, minus the source note ids that nothing downstream reads. */
const recoverFromGenerated = (
  source: DeckSource,
  repositoryRoot: string,
  audioRoot: string,
): Effect.Effect<DeckWords, ExtractError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const generatedRoot = join(repositoryRoot, "public", "game-data", source.id);
    const text = yield* fs.readTextFile(join(generatedRoot, "deck.json")).pipe(
      Effect.catchTag("FsError", (error) =>
        Effect.fail(new AcardExtractionError({
          detail: `Cannot recover ${source.id}: ${error.detail}. Neither its .apkg nor its generated deck.json is usable.`,
        }))),
    );
    const deck = JSON.parse(text) as { words: Array<Record<string, unknown>> };
    const words: CompiledWord[] = [];
    const audioNameByFilename = new Map<string, string>();
    const seenAudio = new Set<string>();
    let audioBytes = 0;
    for (const raw of deck.words) {
      const audioUrl = String(raw.audioUrl ?? "");
      const filename = audioUrl.split("/").pop() ?? "";
      if (filename && !seenAudio.has(filename)) {
        seenAudio.add(filename);
        yield* fs.copyFile(join(generatedRoot, audioUrl), join(audioRoot, filename));
        audioBytes += yield* fs.statSize(join(audioRoot, filename));
      }
      if (filename) audioNameByFilename.set(filename, filename);
      words.push({
        id: String(raw.id),
        sourceGuids: (raw.sourceGuids as string[] | undefined) ?? [],
        displayHanzi: String(raw.displayHanzi),
        hanziKey: String(raw.hanziKey),
        displayPinyin: String(raw.displayPinyin),
        acceptedPinyin: (raw.acceptedPinyin as string[] | undefined) ?? [],
        partOfSpeech: (raw.partOfSpeech as string | null | undefined) ?? null,
        partOfSpeechKey: (raw.partOfSpeechKey as string | null | undefined) ?? null,
        senseLabel: (raw.senseLabel as string | null | undefined) ?? null,
        meaning: String(raw.meaning),
        meaningKey: String(raw.meaningKey),
        audioUrl: "",
        audioFilename: filename,
        sourceNoteId: 0,
      });
    }
    return { words, from: "generated-deck-json", audioNameByFilename, audioBytes, audioAssets: seenAudio.size };
  });

export type ExtractOptions = {
  repositoryRoot: string;
  cardsRoot?: string;
  /** Grades whose `.apkg` is unusable and must come from the generated deck. */
  recover?: string[];
  /** Default true: print the plan and write nothing. */
  dryRun?: boolean;
  /** Overwrite hand-edited cards. Refused without it. */
  force?: boolean;
};

export const extractAcards = (
  options: ExtractOptions,
): Effect.Effect<ExtractionReport, ExtractError, Fs | AnkiDatabase> =>
  Effect.scoped(Effect.gen(function* () {
    const fs = yield* Fs;
    const { repositoryRoot } = options;
    const cardsRoot = options.cardsRoot ?? join(repositoryRoot, "cards");
    const dryRun = options.dryRun ?? true;
    const recover = new Set(options.recover ?? []);

    // Audio is content-addressed, so extracting it is idempotent. A dry run
    // still needs the digests (they are part of the card content being
    // diffed), so it stages them in a scratch directory that is then dropped.
    const audioRoot = dryRun
      ? yield* Effect.acquireRelease(
          fs.mkdtemp(join(tmpdir(), "hsk-acards-audio-")),
          (directory) => Effect.ignore(fs.rmRecursive(directory)),
        )
      : join(cardsRoot, "audio");
    yield* fs.mkdirRecursive(audioRoot);

    const checksums = yield* readChecksumFileEffect(join(repositoryRoot, "decks", "SHA256SUMS"));
    const overridesText = yield* fs.readTextFile(join(repositoryRoot, "tools", "import-decks", "overrides.json"));
    const overrides = JSON.parse(overridesText) as Overrides;

    const perDeck: Array<{ source: DeckSource } & DeckWords> = [];
    for (const source of DECK_SOURCES) {
      const result = recover.has(source.id)
        ? yield* recoverFromGenerated(source, repositoryRoot, audioRoot)
        : yield* readFromPackage(source, repositoryRoot, overrides, checksums.get(source.filename), audioRoot);
      perDeck.push({ source, ...result });
    }
    // Audio is content-addressed into one shared directory, so blobs identical
    // across grades collapse to a single file. Per-deck counts would double
    // count those, so the totals are taken over the deduplicated set.
    const audioNames = new Set<string>();
    for (const deck of perDeck) for (const name of deck.audioNameByFilename.values()) audioNames.add(name);
    let audioBytes = 0;
    for (const name of audioNames) audioBytes += yield* fs.statSize(join(audioRoot, name));
    const audioAssets = audioNames.size;

    // `components` spans the whole corpus, so it can only be computed once
    // every grade has been read.
    const corpus = new Set<string>();
    for (const deck of perDeck) for (const word of deck.words) corpus.add(word.displayHanzi);

    const ledger = yield* readLedger(cardsRoot);
    const nextLedger: ExtractionLedger = { extractorVersion: EXTRACTOR_VERSION, files: {} };
    const entries: PlanEntry[] = [];

    for (const deck of perDeck) {
      if (!dryRun) yield* fs.mkdirRecursive(join(cardsRoot, deck.source.id));
      const taken = new Set<string>();
      for (const word of [...deck.words].sort((a, b) => a.id.localeCompare(b.id))) {
        const name = acardFilename(word.displayHanzi, word.acceptedPinyin[0] ?? "x", word.id, taken);
        taken.add(name);
        const relative = `${deck.source.id}/${name}`;
        const absolute = join(cardsRoot, relative);

        const existingText = yield* fs.readTextFile(absolute).pipe(
          Effect.catchTag("FsError", (error) => (error.code === "ENOENT" ? Effect.succeed("") : Effect.fail(error))),
        );
        // Extraction owns identity, content and provenance; the sorter owns the
        // curriculum block. They write disjoint key sets, so a re-extraction
        // carries an existing card's curriculum forward untouched — except
        // `components`, which extraction derives.
        let curriculum = blankCurriculum(deck.source.hskLevel, componentsOf(word.displayHanzi, corpus));
        if (existingText) {
          const previous = AcardSchema.safeParse(JSON.parse(existingText));
          if (previous.success) curriculum = { ...previous.data.curriculum, components: curriculum.components };
        }

        const card: Acard = {
          schema: ACARD_SCHEMA,
          audio: deck.audioNameByFilename.get(word.audioFilename) ?? null,
          curriculum,
          hanzi: word.displayHanzi,
          id: word.id,
          level: deck.source.hskLevel,
          meaning: word.meaning,
          pinyin: word.displayPinyin,
          pos: word.partOfSpeech,
          senseLabel: word.senseLabel,
          source: {
            deck: deck.from === "generated-deck-json"
              ? `${deck.source.filename} (recovered via generated deck.json)`
              : deck.source.filename,
            guids: [...word.sourceGuids].sort(),
            overrides: word.sourceGuids
              .filter((guid) => overrides[guid])
              .map((guid) => ({ guid, reason: overrides[guid]!.reason }))
              .sort((a, b) => a.guid.localeCompare(b.guid)),
            sharedId: deck.source.sharedId,
          },
        };
        const parsed = AcardSchema.safeParse(card);
        if (!parsed.success) {
          return yield* Effect.fail(new AcardExtractionError({
            detail: `Generated card ${relative} fails acard/1: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          }));
        }
        const text = stableJson(card);
        nextLedger.files[relative] = sha256(text);

        const action: PlanEntry["action"] = !existingText
          ? "create"
          : existingText === text
            ? "identical"
            : ledger.files[relative] && sha256(existingText) !== ledger.files[relative]
              ? "conflict"
              : "update";
        entries.push({ path: relative, action });

        if (!dryRun && action !== "identical" && (action !== "conflict" || options.force)) {
          yield* fs.writeFile(absolute, text);
        }
      }
    }

    const conflicts = entries.filter((entry) => entry.action === "conflict");
    if (conflicts.length && !options.force) {
      return yield* Effect.fail(new AcardExtractionError({
        detail: `${conflicts.length} card(s) have been edited since the last extraction and would be overwritten:\n` +
          conflicts.slice(0, 20).map((entry) => `  ${entry.path}`).join("\n") +
          (conflicts.length > 20 ? `\n  … and ${conflicts.length - 20} more` : "") +
          `\nRe-run with --force to discard those edits.`,
      }));
    }
    if (!dryRun) yield* fs.writeFile(join(cardsRoot, LEDGER_NAME), stableJson(nextLedger));

    return {
      entries,
      audioAssets,
      audioBytes,
      byDeck: perDeck.map((deck) => ({ id: deck.source.id, words: deck.words.length, from: deck.from })),
      wrote: !dryRun,
    };
  }));
