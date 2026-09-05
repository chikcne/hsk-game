import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
import { RuntimeDeckSchema, type RuntimeDeck, type RuntimeWord } from "../../../src/shared/schemas";
import type { DeckId } from "../../../src/shared/constants";
import { DECK_SOURCES, IMPORTER_VERSION, type DeckSource } from "./compiler";
import { buildMeaningIndexesEffect, type WordImportError } from "../normalize/words";
import { normalizeHanzi } from "../normalize/hanzi";
import { acceptedPinyinForms } from "../normalize/pinyin";
import { normalizedKey } from "../normalize/text";
import { stableJson } from "./stable-json";
import { Fs, type FsError } from "../../shared/fs";
import { loadGradeCards, CardLoadError, type LoadedCard } from "../../shared/load-cards";
import { CurriculumManifestSchema, type CurriculumManifest } from "../../sort-curriculum/types";

/** Typed failure for compiling `cards/` into the runtime bundles. */
export class CardCompileError extends Data.TaggedError("CardCompileError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

export type CardCompileFailure = CardCompileError | CardLoadError | WordImportError | FsError;

export type CardDeckReport = {
  id: DeckId;
  fingerprint: string;
  logicalWordCount: number;
  output: { deckJsonBytes: number; audioBytes: number; audioAssetCount: number };
  minimumSafeDistractors: number;
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function validateManifestAgainstCards(
  manifest: CurriculumManifest,
  loadedByFile: ReadonlyMap<string, LoadedCard>,
): string | null {
  const expectedDeckIds = new Set(DECK_SOURCES.map((source) => source.id));
  const seenDeckIds = new Set<string>();
  const seenFiles = new Set<string>();
  const firstPlacementById = new Map<string, { grade: number; lesson: number }>();

  for (const level of manifest.levels) {
    if (!expectedDeckIds.has(level.deckId as DeckId) || seenDeckIds.has(level.deckId)) return `duplicate or unknown curriculum level ${level.deckId}`;
    seenDeckIds.add(level.deckId);
    if (level.hskLevel !== Number(level.deckId.at(-1))) return `${level.deckId}: hskLevel does not match deckId`;
    const entries = level.lessons.flatMap((lesson) => lesson.cards);
    if (level.cardCount !== entries.length) return `${level.deckId}: cardCount does not match its lessons`;
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) return `${level.deckId}: duplicate IDs within effective grade`;
    if (new Set(level.lessons.map((lesson) => lesson.id)).size !== level.lessons.length) return `${level.deckId}: duplicate lesson IDs`;
    for (const [lessonIndex, lesson] of level.lessons.entries()) {
      for (const entry of lesson.cards) {
        if (seenFiles.has(entry.file)) return `${entry.file}: source card appears more than once in curriculum`;
        seenFiles.add(entry.file);
        const loaded = loadedByFile.get(entry.file);
        if (!loaded) return `${entry.file}: curriculum references a missing source card`;
        if (loaded.card.id !== entry.id || loaded.card.hanzi !== entry.hanzi) return `${entry.file}: curriculum metadata is stale`;
        if (loaded.card.curriculum.grade !== level.hskLevel) return `${entry.file}: effective grade does not match ${level.deckId}`;
        if (!firstPlacementById.has(entry.id)) firstPlacementById.set(entry.id, { grade: level.hskLevel, lesson: lessonIndex });
      }
    }
  }
  if (seenDeckIds.size !== expectedDeckIds.size) return "curriculum does not contain every HSK grade";
  if (seenFiles.size !== loadedByFile.size) return "curriculum does not contain every source card exactly once";

  for (const level of manifest.levels) for (const [lessonIndex, lesson] of level.lessons.entries()) for (const entry of lesson.cards) {
    for (const prerequisiteId of entry.prerequisiteIds) {
      const prerequisite = firstPlacementById.get(prerequisiteId);
      if (!prerequisite) return `${entry.file}: prerequisite ${prerequisiteId} is missing`;
      if (prerequisite.grade > level.hskLevel || (prerequisite.grade === level.hskLevel && prerequisite.lesson >= lessonIndex)) {
        return `${entry.file}: prerequisite ${prerequisiteId} is not in an earlier grade or lesson`;
      }
    }
  }
  return null;
}

/** The deck fingerprint once the `.apkg` packages stop being build inputs: a
 * digest over the `cards/` content that actually determines the compiled deck.
 * Deliberately excludes the `curriculum` block, so re-sorting the lessons is
 * not a deck-content change and never reconciles a save. */
export function cardsFingerprint(cards: readonly LoadedCard[]): string {
  const body = cards
    .map(({ card }) =>
      [card.id, card.hanzi, card.pinyin, card.meaning, card.pos ?? "", card.senseLabel ?? "", card.audio ?? ""].join("\u0000"))
    .sort()
    .join("\u0000\u0000");
  return digest(`deck-v2\u0000${IMPORTER_VERSION}\u0000${body}`);
}

/** Rebuilds the derived fields an `.acard` deliberately does not store. */
function toRuntimeWord(card: LoadedCard["card"]): RuntimeWord {
  return {
    id: card.id,
    sourceGuids: [...card.source.guids].sort(),
    displayHanzi: card.hanzi,
    hanziKey: normalizeHanzi(card.hanzi).hanziKey,
    displayPinyin: card.pinyin,
    acceptedPinyin: acceptedPinyinForms(card.pinyin),
    partOfSpeech: card.pos,
    partOfSpeechKey: card.pos ? normalizedKey(card.pos) || null : null,
    senseLabel: card.senseLabel,
    meaning: card.meaning,
    meaningKey: normalizedKey(card.meaning),
    audioUrl: card.audio ? `audio/${card.audio}` : "",
  };
}

const compileOneGrade = (
  source: DeckSource,
  cardsRoot: string,
  outputRoot: string,
  cards: LoadedCard[],
  curriculum: { rulesVersion: string; lessonSize: 20; lessons: Array<{ id: string; wordIds: string[] }> },
): Effect.Effect<{ deck: RuntimeDeck; report: CardDeckReport; indexEntry: Record<string, unknown> }, CardCompileFailure, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    if (!cards.length) {
      return yield* Effect.fail(new CardCompileError({ detail: `${source.id}: curriculum contains no cards` }));
    }
    const words = cards.map(({ card }) => toRuntimeWord(card));
    const indexes = yield* buildMeaningIndexesEffect(words);
    const fingerprint = cardsFingerprint(cards);

    // Audio is content-addressed in cards/audio and copied per grade, keeping
    // the client's existing deck-relative `audio/<sha256>.mp3` URL contract.
    const deckOutput = join(outputRoot, source.id);
    yield* fs.mkdirRecursive(join(deckOutput, "audio"));
    let audioBytes = 0;
    const copied = new Set<string>();
    for (const { relative, card } of cards) {
      if (!card.audio || copied.has(card.audio)) continue;
      copied.add(card.audio);
      yield* fs.copyFile(join(cardsRoot, "audio", card.audio), join(deckOutput, "audio", card.audio)).pipe(
        Effect.catchTag("FsError", (error) =>
          Effect.fail(new CardCompileError({ detail: `${relative}: audio ${card.audio} could not be copied (${error.detail})` }))),
      );
      audioBytes += yield* fs.statSize(join(deckOutput, "audio", card.audio));
    }

    const deck = yield* Effect.try({
      try: () =>
        RuntimeDeckSchema.parse({
          schemaVersion: 1,
          importerVersion: IMPORTER_VERSION,
          id: source.id,
          hskLevel: source.hskLevel,
          title: source.title,
          fingerprint,
          source: {
            sharedId: source.sharedId,
            url: `https://ankiweb.net/shared/info/${source.sharedId}`,
            packageSha256: "",
            sourceNoteCount: cards.length,
            logicalWordCount: words.length,
          },
          curriculum,
          words,
          meaningIndex: indexes.meaningIndex,
          meaningKeysByPartOfSpeech: indexes.meaningKeysByPartOfSpeech,
          allMeaningKeys: indexes.allMeaningKeys,
        }),
      catch: (error) => new CardCompileError({ detail: error instanceof Error ? error.message : String(error) }),
    });
    const deckJson = stableJson(deck);
    yield* fs.writeFile(join(deckOutput, "deck.json"), deckJson, { exclusive: true });
    return {
      deck,
      report: {
        id: source.id,
        fingerprint,
        logicalWordCount: words.length,
        output: { deckJsonBytes: Buffer.byteLength(deckJson), audioBytes, audioAssetCount: copied.size },
        minimumSafeDistractors: indexes.minimumSafeDistractors,
      },
      indexEntry: {
        id: source.id,
        hskLevel: source.hskLevel,
        title: source.title,
        fingerprint,
        logicalWordCount: words.length,
        deckUrl: `${source.id}/deck.json`,
      },
    };
  });

const atomicReplace = (tempOutput: string, outputDirectory: string): Effect.Effect<void, FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backup = `${outputDirectory}.old-${randomUUID()}`;
    const hadPrevious = yield* fs.rename(outputDirectory, backup).pipe(
      Effect.as(true),
      Effect.catchTag("FsError", (error) => (error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error))),
    );
    yield* fs.rename(tempOutput, outputDirectory).pipe(
      Effect.catchTag("FsError", (error) =>
        hadPrevious ? Effect.zipRight(fs.rename(backup, outputDirectory), Effect.fail(error)) : Effect.fail(error)),
    );
    if (hadPrevious) yield* fs.rmRecursive(backup);
  });

export type CompileFromCardsOptions = {
  repositoryRoot?: string;
  cardsRoot?: string;
  outputDirectory?: string;
  deckIds?: DeckId[];
};

/** Compiles `cards/` into `public/game-data/`. Builds into a sibling temporary
 * tree and swaps it in only after every grade validates, so a failure leaves
 * the previous generated data untouched. */
export const compileFromCardsEffect = (
  options: CompileFromCardsOptions = {},
): Effect.Effect<{ decks: RuntimeDeck[]; reports: CardDeckReport[] }, CardCompileFailure, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const repositoryRoot = options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const cardsRoot = options.cardsRoot ?? join(repositoryRoot, "cards");
    const outputDirectory = options.outputDirectory ?? join(repositoryRoot, "public", "game-data");
    const sources = DECK_SOURCES.filter((source) => !options.deckIds || options.deckIds.includes(source.id));
    const tempOutput = `${outputDirectory}.tmp-${randomUUID()}`;

    return yield* Effect.gen(function* () {
      yield* fs.mkdirRecursive(tempOutput);
      const manifest = yield* fs.readTextFile(join(cardsRoot, "curriculum.json")).pipe(
        Effect.flatMap((text) => Effect.try({
          try: () => CurriculumManifestSchema.parse(JSON.parse(text)),
          catch: (error) => new CardCompileError({ detail: `Invalid cards/curriculum.json: ${String(error)}` }),
        })),
      );
      const loadedByFile = new Map<string, LoadedCard>();
      for (const grade of DECK_SOURCES) {
        for (const loaded of yield* loadGradeCards(cardsRoot, grade.id)) loadedByFile.set(loaded.relative, loaded);
      }
      const manifestError = validateManifestAgainstCards(manifest, loadedByFile);
      if (manifestError) return yield* Effect.fail(new CardCompileError({ detail: manifestError }));
      const decks: RuntimeDeck[] = [];
      const reports: CardDeckReport[] = [];
      const indexEntries: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        const level = manifest.levels.find((candidate) => candidate.deckId === source.id);
        if (!level) return yield* Effect.fail(new CardCompileError({ detail: `Curriculum is missing ${source.id}` }));
        const entries = level.lessons.flatMap((lesson) => lesson.cards);
        const cards: LoadedCard[] = [];
        for (const entry of entries) {
          const loaded = loadedByFile.get(entry.file);
          if (!loaded || loaded.card.id !== entry.id) {
            return yield* Effect.fail(new CardCompileError({ detail: `Curriculum entry ${entry.file} does not match its card` }));
          }
          if (loaded.card.curriculum.grade !== source.hskLevel) {
            return yield* Effect.fail(new CardCompileError({ detail: `${entry.file}: effective grade does not match ${source.id}` }));
          }
          cards.push(loaded);
        }
        const compiled = yield* compileOneGrade(source, cardsRoot, tempOutput, cards, {
          rulesVersion: manifest.generator.rulesVersion,
          lessonSize: manifest.lessonSize,
          lessons: level.lessons.map((lesson) => ({ id: lesson.id, wordIds: lesson.cards.map((card) => card.id) })),
        });
        decks.push(compiled.deck);
        reports.push(compiled.report);
        indexEntries.push(compiled.indexEntry);
      }
      yield* fs.writeFile(
        join(tempOutput, "index.json"),
        stableJson({ schemaVersion: 1, importerVersion: IMPORTER_VERSION, decks: indexEntries }),
        { exclusive: true },
      );
      yield* fs.writeFile(
        join(tempOutput, "import-report.json"),
        stableJson({ importerVersion: IMPORTER_VERSION, source: "cards", decks: reports }),
        { exclusive: true },
      );
      yield* atomicReplace(tempOutput, outputDirectory);
      return { decks, reports };
    }).pipe(Effect.tapError(() => Effect.ignore(fs.rmRecursive(tempOutput))));
  });
