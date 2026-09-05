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
): Effect.Effect<{ deck: RuntimeDeck; report: CardDeckReport; indexEntry: Record<string, unknown> }, CardCompileFailure, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const cards = yield* loadGradeCards(cardsRoot, source.id);
    if (!cards.length) {
      return yield* Effect.fail(new CardCompileError({ detail: `${source.id}: no .acard files found under ${cardsRoot}` }));
    }
    for (const { relative, card } of cards) {
      if (card.curriculum.grade !== source.hskLevel) {
        return yield* Effect.fail(new CardCompileError({
          detail: `${relative}: curriculum.grade ${card.curriculum.grade} does not match its directory`,
        }));
      }
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
      const decks: RuntimeDeck[] = [];
      const reports: CardDeckReport[] = [];
      const indexEntries: Array<Record<string, unknown>> = [];
      for (const source of sources) {
        const compiled = yield* compileOneGrade(source, cardsRoot, tempOutput);
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
