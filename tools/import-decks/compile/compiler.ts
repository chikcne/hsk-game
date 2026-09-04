import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Data, Effect, Layer } from "effect";
import { RuntimeDeckSchema, type RuntimeDeck } from "../../../src/shared/schemas";
import { type DeckId } from "../../../src/shared/constants";
import { extractArchiveEssentialsEffect, readChecksumFileEffect, ArchiveError } from "../archive/zip";
import { readMediaMapEffect, MediaError, SoundReferenceError } from "../archive/media";
import { AnkiDatabase, CollectionError } from "../sqlite/read-collection";
import { buildMeaningIndexesEffect, normalizeAndDedupeEffect, type Overrides, type WordAudit, type WordImportError } from "../normalize/words";
import { HanziError } from "../normalize/hanzi";
import { extractSelectedAudio, AudioError } from "./audio";
import { stableJson } from "./stable-json";
import { Fs, FsError } from "../../shared/fs";
import { sha256File as sha256FileEffect } from "../../shared/hash";

export const IMPORTER_VERSION = "1.0.0";

export type DeckSource = {
  id: DeckId;
  hskLevel: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  sharedId: number;
  filename: string;
  expectedSourceNotes: number;
  expectedLogicalWords: number;
};

export const DECK_SOURCES: readonly DeckSource[] = [
  { id: "hsk-1", hskLevel: 1, title: "HSK 1", sharedId: 1623336797, filename: "hsk-1-1623336797.apkg", expectedSourceNotes: 300, expectedLogicalWords: 300 },
  { id: "hsk-2", hskLevel: 2, title: "HSK 2", sharedId: 1488171715, filename: "hsk-2-1488171715.apkg", expectedSourceNotes: 200, expectedLogicalWords: 200 },
  { id: "hsk-3", hskLevel: 3, title: "HSK 3", sharedId: 1074787074, filename: "hsk-3-1074787074.apkg", expectedSourceNotes: 500, expectedLogicalWords: 500 },
  { id: "hsk-4", hskLevel: 4, title: "HSK 4", sharedId: 562028400, filename: "hsk-4-562028400.apkg", expectedSourceNotes: 1000, expectedLogicalWords: 1000 },
  { id: "hsk-5", hskLevel: 5, title: "HSK 5", sharedId: 345498902, filename: "hsk-5-345498902.apkg", expectedSourceNotes: 1601, expectedLogicalWords: 1600 },
  { id: "hsk-6", hskLevel: 6, title: "HSK 6", sharedId: 395921696, filename: "hsk-6-395921696.apkg", expectedSourceNotes: 1800, expectedLogicalWords: 1798 },
] as const;

export type DeckReport = {
  id: DeckId;
  fingerprint: string;
  packageSha256: string;
  checksumStatus: "verified";
  sourceNoteCount: number;
  sourceCardCount: number;
  sourceMediaCount: number;
  logicalWordCount: number;
  exactDuplicateGroups: WordAudit["exactDuplicateGroups"];
  appliedOverrides: WordAudit["appliedOverrides"];
  nfkcChangedValues: WordAudit["nfkcChangedValues"];
  parsedSenseLabels: WordAudit["parsedSenseLabels"];
  blankFields: WordAudit["blankFields"];
  malformedAudio: never[];
  missingAudio: never[];
  pinyinAlternatives: WordAudit["pinyinAlternatives"];
  canonicalPinyinCollisions: WordAudit["canonicalPinyinCollisions"];
  maxMeaningLength: number;
  distractorPool: { minimumSafeDistractors: number; valid: true };
  output: { deckJsonBytes: number; audioBytes: number; audioAssetCount: number };
  blockingErrors: never[];
  warnings: string[];
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Typed failure for deck compilation and generated-data verification. */
export class ImportError extends Data.TaggedError("ImportError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

/** Union of every typed failure the deck compilation pipeline can emit. */
export type CompileError =
  | ImportError
  | FsError
  | ArchiveError
  | MediaError
  | SoundReferenceError
  | WordImportError
  | HanziError
  | AudioError
  | CollectionError;

const parseOverridesEffect = (text: string): Effect.Effect<Overrides, ImportError, never> =>
  Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (error) => new ImportError({ detail: error instanceof Error ? error.message : String(error) }),
    });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return yield* Effect.fail(new ImportError({ detail: "overrides.json must be an object" }));
    }
    const result: Overrides = {};
    for (const [guid, item] of Object.entries(value)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return yield* Effect.fail(new ImportError({ detail: `Override ${guid} must be an object` }));
      }
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.displayHanzi !== "string" || typeof candidate.reason !== "string" || !candidate.reason.trim()) {
        return yield* Effect.fail(new ImportError({ detail: `Override ${guid} must contain displayHanzi and a nonblank reason` }));
      }
      result[guid] = { displayHanzi: candidate.displayHanzi, reason: candidate.reason };
    }
    return result;
  });

export type CompileOptions = {
  repositoryRoot?: string;
  outputDirectory?: string;
  deckIds?: DeckId[];
};

type CompiledDeck = { deck: RuntimeDeck; report: DeckReport; indexEntry: Record<string, unknown> };

const compileOneDeckEffect = (
  source: DeckSource,
  repositoryRoot: string,
  outputRoot: string,
  expectedChecksum: string,
  overrides: Overrides,
  overrideSha256: string,
): Effect.Effect<CompiledDeck, CompileError, Fs | AnkiDatabase> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* Fs;
      const apkgPath = join(repositoryRoot, "decks", source.filename);
      const packageSha256 = yield* sha256FileEffect(apkgPath);
      if (packageSha256 !== expectedChecksum) {
        return yield* Effect.fail(new ImportError({
          detail: `Checksum mismatch for ${source.filename}: expected ${expectedChecksum}, got ${packageSha256}`,
        }));
      }
      const extractionDirectory = yield* Effect.acquireRelease(
        fs.mkdtemp(join(tmpdir(), `hsk-import-${source.id}-`)),
        (directory) => Effect.ignore(fs.rmRecursive(directory)),
      );
      const essentials = yield* extractArchiveEssentialsEffect(apkgPath, extractionDirectory);
      const anki = yield* AnkiDatabase;
      const collection = yield* anki.readCollection(essentials.collectionPath);
      if (collection.noteCount !== source.expectedSourceNotes) {
        return yield* Effect.fail(new ImportError({
          detail: `${source.id} has ${collection.noteCount} source notes; expected ${source.expectedSourceNotes}`,
        }));
      }
      const media = yield* readMediaMapEffect(essentials.mediaPath);
      const normalized = yield* normalizeAndDedupeEffect(collection.notes, media, overrides);
      if (normalized.words.length !== source.expectedLogicalWords) {
        return yield* Effect.fail(new ImportError({
          detail: `${source.id} has ${normalized.words.length} logical words; expected ${source.expectedLogicalWords}`,
        }));
      }
      const deckOutput = join(outputRoot, source.id);
      const selectedMedia = new Map<string, string>();
      for (const word of normalized.words) selectedMedia.set(word.audioFilename, media.memberByFilename.get(word.audioFilename)!);
      const audio = yield* extractSelectedAudio(apkgPath, selectedMedia, join(deckOutput, "audio"));
      for (const word of normalized.words) {
        const url = audio.urlByFilename.get(word.audioFilename);
        if (!url) {
          return yield* Effect.fail(new ImportError({ detail: `No extracted audio URL for ${word.audioFilename}` }));
        }
        word.audioUrl = url;
      }
      const runtimeWords = normalized.words.map(({ audioFilename: _audio, sourceNoteId: _note, ...word }) => word);
      const indexes = yield* buildMeaningIndexesEffect(runtimeWords);
      const fingerprint = digest(`deck-v1\0${IMPORTER_VERSION}\0${packageSha256}\0${overrideSha256}`);
      const deck = yield* Effect.try({
        try: () =>
          RuntimeDeckSchema.parse({
            schemaVersion: 1, importerVersion: IMPORTER_VERSION, id: source.id, hskLevel: source.hskLevel,
            title: source.title, fingerprint,
            source: {
              sharedId: source.sharedId, url: `https://ankiweb.net/shared/info/${source.sharedId}`,
              packageSha256, sourceNoteCount: collection.noteCount, logicalWordCount: runtimeWords.length,
            },
            words: runtimeWords, meaningIndex: indexes.meaningIndex,
            meaningKeysByPartOfSpeech: indexes.meaningKeysByPartOfSpeech, allMeaningKeys: indexes.allMeaningKeys,
          }),
        catch: (error) => new ImportError({ detail: error instanceof Error ? error.message : String(error) }),
      });
      const deckJson = stableJson(deck);
      yield* fs.mkdirRecursive(deckOutput);
      yield* fs.writeFile(join(deckOutput, "deck.json"), deckJson, { exclusive: true });
      const warnings = normalized.audit.blankFields.length ? ["Some optional source fields are blank; see blankFields."] : [];
      if (normalized.audit.canonicalPinyinCollisions.length) warnings.push("Tone-insensitive pinyin forms collide; words remain separate.");
      const report: DeckReport = {
        id: source.id, fingerprint, packageSha256, checksumStatus: "verified",
        sourceNoteCount: collection.noteCount, sourceCardCount: collection.cardCount, sourceMediaCount: media.filenameByMember.size,
        logicalWordCount: runtimeWords.length, exactDuplicateGroups: normalized.audit.exactDuplicateGroups,
        appliedOverrides: normalized.audit.appliedOverrides, nfkcChangedValues: normalized.audit.nfkcChangedValues,
        parsedSenseLabels: normalized.audit.parsedSenseLabels, blankFields: normalized.audit.blankFields,
        malformedAudio: [], missingAudio: [], pinyinAlternatives: normalized.audit.pinyinAlternatives,
        canonicalPinyinCollisions: normalized.audit.canonicalPinyinCollisions,
        maxMeaningLength: normalized.audit.maxMeaningLength,
        distractorPool: { minimumSafeDistractors: indexes.minimumSafeDistractors, valid: true },
        output: { deckJsonBytes: Buffer.byteLength(deckJson), audioBytes: audio.totalBytes, audioAssetCount: audio.assetCount },
        blockingErrors: [], warnings,
      };
      return {
        deck, report,
        indexEntry: {
          id: source.id, hskLevel: source.hskLevel, title: source.title, fingerprint,
          logicalWordCount: runtimeWords.length, deckUrl: `${source.id}/deck.json`,
        },
      };
    }),
  );

/** Atomically swaps `tempOutput` into `outputDirectory`, restoring the previous
 * directory if the final rename fails. */
const atomicReplaceEffect = (tempOutput: string, outputDirectory: string): Effect.Effect<void, FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backup = `${outputDirectory}.old-${randomUUID()}`;
    const hadPrevious = yield* fs.rename(outputDirectory, backup).pipe(
      Effect.as(true),
      Effect.catchTag("FsError", (error) => (error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error))),
    );
    yield* fs.rename(tempOutput, outputDirectory).pipe(
      Effect.catchTag("FsError", (error) =>
        hadPrevious
          ? Effect.zipRight(fs.rename(backup, outputDirectory), Effect.fail(error))
          : Effect.fail(error)),
    );
    if (hadPrevious) yield* fs.rmRecursive(backup);
  });

/** Compiles the selected decks into a temporary output tree and atomically
 * replaces the generated data directory on success. */
export const compileDecksEffect = (
  options: CompileOptions = {},
): Effect.Effect<{ decks: RuntimeDeck[]; reports: DeckReport[] }, CompileError, Fs | AnkiDatabase> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* Fs;
      const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
      const outputDirectory = resolve(options.outputDirectory ?? join(repositoryRoot, "public/game-data"));
      const selectedIds = options.deckIds ? new Set(options.deckIds) : null;
      const sources = DECK_SOURCES.filter((source) => !selectedIds || selectedIds.has(source.id));
      if (!sources.length) {
        return yield* Effect.fail(new ImportError({ detail: "No decks selected" }));
      }
      if (selectedIds && sources.length !== selectedIds.size) {
        return yield* Effect.fail(new ImportError({ detail: "Unknown deck ID selected" }));
      }

      const checksumByFilename = yield* readChecksumFileEffect(join(repositoryRoot, "decks/SHA256SUMS"));
      const overridesText = yield* fs.readTextFile(join(repositoryRoot, "tools/import-decks/overrides.json"));
      const overrides = yield* parseOverridesEffect(overridesText);
      const overrideSha256 = digest(overridesText);
      yield* fs.mkdirRecursive(dirname(outputDirectory));
      const tempOutput = `${outputDirectory}.tmp-${randomUUID()}`;
      yield* Effect.acquireRelease(
        Effect.as(fs.mkdirRecursive(tempOutput), tempOutput),
        () => Effect.ignore(fs.rmRecursive(tempOutput)),
      );
      const compiled = yield* Effect.forEach(
        sources,
        (source) =>
          Effect.gen(function* () {
            const expected = checksumByFilename.get(source.filename);
            if (!expected) {
              return yield* Effect.fail(new ImportError({ detail: `No SHA-256 entry for ${source.filename}` }));
            }
            return yield* compileOneDeckEffect(source, repositoryRoot, tempOutput, expected, overrides, overrideSha256);
          }),
        { concurrency: 1 },
      );
      if (!selectedIds) {
        const applied = new Set(compiled.flatMap((item) => item.report.appliedOverrides.map((entry) => entry.guid)));
        for (const guid of Object.keys(overrides)) {
          if (!applied.has(guid)) {
            return yield* Effect.fail(new ImportError({ detail: `Reviewed override GUID was not found: ${guid}` }));
          }
        }
      }
      const index = {
        schemaVersion: 1, importerVersion: IMPORTER_VERSION,
        decks: compiled.map((item) => item.indexEntry).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      };
      const report = {
        schemaVersion: 1, importerVersion: IMPORTER_VERSION, overrideSha256,
        decks: compiled.map((item) => item.report).sort((a, b) => a.id.localeCompare(b.id)),
      };
      yield* fs.writeFile(join(tempOutput, "index.json"), stableJson(index), { exclusive: true });
      yield* fs.writeFile(join(tempOutput, "import-report.json"), stableJson(report), { exclusive: true });
      yield* atomicReplaceEffect(tempOutput, outputDirectory);
      return { decks: compiled.map((item) => item.deck), reports: compiled.map((item) => item.report) };
    }),
  );

type GeneratedIndexFile = {
  importerVersion?: unknown;
  decks?: Array<{ id?: unknown; fingerprint?: unknown; deckUrl?: unknown }>;
};

/** Verifies the committed generated deck data is present, checksum-fresh, and
 * internally consistent with its index. */
export const checkGeneratedDataEffect = (
  options: Omit<CompileOptions, "outputDirectory"> = {},
): Effect.Effect<void, CompileError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
    const indexPath = join(repositoryRoot, "public/game-data/index.json");
    const index: GeneratedIndexFile = yield* Effect.gen(function* () {
      const text = yield* fs.readTextFile(indexPath);
      return yield* Effect.try({
        try: () => JSON.parse(text) as GeneratedIndexFile,
        catch: (error) => new ImportError({ detail: error instanceof Error ? error.message : String(error) }),
      });
    }).pipe(
      Effect.catchAll(() => Effect.fail(new ImportError({ detail: "Generated deck data is missing. Run npm run import:decks." }))),
    );
    if (index.importerVersion !== IMPORTER_VERSION || !Array.isArray(index.decks)) {
      return yield* Effect.fail(new ImportError({ detail: "Generated deck data is stale. Run npm run import:decks." }));
    }
    const indexDecks = index.decks;
    const checksumByFilename = yield* readChecksumFileEffect(join(repositoryRoot, "decks/SHA256SUMS"));
    const overridesText = yield* fs.readTextFile(join(repositoryRoot, "tools/import-decks/overrides.json"));
    const overrideSha256 = digest(overridesText);
    const selectedIds = options.deckIds ? new Set(options.deckIds) : null;
    const sources = DECK_SOURCES.filter((source) => !selectedIds || selectedIds.has(source.id));
    yield* Effect.forEach(
      sources,
      (source) =>
        Effect.gen(function* () {
          const recordedSha256 = checksumByFilename.get(source.filename);
          const packageSha256 = yield* sha256FileEffect(join(repositoryRoot, "decks", source.filename));
          if (!recordedSha256 || packageSha256 !== recordedSha256) {
            return yield* Effect.fail(new ImportError({
              detail: `Source checksum mismatch for ${source.id}; generated data cannot be trusted.`,
            }));
          }
          const expectedFingerprint = digest(`deck-v1\0${IMPORTER_VERSION}\0${packageSha256}\0${overrideSha256}`);
          const entry = indexDecks.find((candidate) => candidate.id === source.id);
          if (!entry || entry.fingerprint !== expectedFingerprint || entry.deckUrl !== `${source.id}/deck.json`) {
            return yield* Effect.fail(new ImportError({ detail: `Generated ${source.id} data is stale. Run npm run import:decks.` }));
          }
          const deckPath = join(repositoryRoot, "public/game-data", entry.deckUrl);
          const deckText = yield* fs.readTextFile(deckPath);
          const deck = yield* Effect.try({
            try: () => RuntimeDeckSchema.parse(JSON.parse(deckText)),
            catch: (error) => new ImportError({ detail: error instanceof Error ? error.message : String(error) }),
          });
          if (deck.id !== source.id || deck.fingerprint !== expectedFingerprint || deck.words.length !== source.expectedLogicalWords) {
            return yield* Effect.fail(new ImportError({ detail: `Generated ${source.id} deck does not match its index. Run npm run import:decks.` }));
          }
          for (const word of deck.words) {
            if (!/^audio\/[a-f0-9]{64}\.mp3$/u.test(word.audioUrl)) {
              return yield* Effect.fail(new ImportError({ detail: `Generated ${source.id} has an unsafe audio URL.` }));
            }
            yield* fs.statSize(join(dirname(deckPath), word.audioUrl));
          }
        }),
      { concurrency: 1 },
    );
    yield* fs.statSize(indexPath);
  });

// --- compatibility boundaries -------------------------------------------------
// The CLI and the test suite consume plain Promises; the live layers bind the
// filesystem and database capability services.

const liveDependencies: Layer.Layer<Fs | AnkiDatabase> = Layer.mergeAll(Fs.layer, AnkiDatabase.layer);

/** Promise boundary: rejects with a typed `CompileError` on failure. */
export const compileDecks = (
  options: CompileOptions = {},
): Promise<{ decks: RuntimeDeck[]; reports: DeckReport[] }> =>
  Effect.runPromise(Effect.provide(compileDecksEffect(options), liveDependencies));

/** Promise boundary: rejects with a typed `CompileError` on failure. */
export const checkGeneratedData = (options: Omit<CompileOptions, "outputDirectory"> = {}): Promise<void> =>
  Effect.runPromise(Effect.provide(checkGeneratedDataEffect(options), liveDependencies));
