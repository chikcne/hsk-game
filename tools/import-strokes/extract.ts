import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { Data, Effect, Stream } from "effect";
import { DECK_IDS, type DeckId } from "../../src/shared/constants";
import { RuntimeDeckSchema, type RuntimeDeck } from "../../src/shared/schemas";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import { Fs, FsError } from "../shared/fs";
import { sha256File as sha256FileEffect } from "../shared/hash";
import type {
  StrokeBundle,
  StrokeBundleManifest,
  StrokeCharacterData,
  StrokeOrderOverride,
  StrokeOverrides,
  StrokePoint,
} from "./types";

export const STROKE_SOURCE = {
  repository: "https://github.com/skishore/makemeahanzi",
  commit: "618dbab8a8ddefb958763c8b4afbaa741a4460de",
  graphicsSha256: "a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee",
  commitDate: "2018-10-16T04:58:13Z",
} as const;

export const EXTRACTION_DATE = "2026-09-01";
const HAN_CHARACTER = /^\p{Script=Han}$/u;
/** Every fixed Han character rendered by the application chrome. Dynamic
 * vocabulary characters continue to come from their deck-scoped bundle. */
export const UI_HANZI_TEXT = "字多多汉续习第课开始一二三四五六级基础词卷日常进阶长篇高通达成温故跨复待选择纸签释义次新当前重学巩固错无已得行中忘记困难良好简单选级返回";
const ALLOWED_TEXT_FALLBACK = new Set(["·", "・", "—", "–", "-", "…", "（", "）", "(", ")"]);
const SVG_TOKEN = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
const SVG_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Typed failure for SVG path syntax problems. */
export class SvgPathError extends Data.TaggedError("SvgPathError")<{ readonly detail: string }> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure for character-level stroke/median shape problems. */
export class CharacterDataError extends Data.TaggedError("CharacterDataError")<{ readonly detail: string }> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure for reviewed stroke-order overrides that are not permutations. */
export class StrokeOrderError extends Data.TaggedError("StrokeOrderError")<{ readonly detail: string }> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure for the graphics.txt stream (bad JSON lines, duplicates,
 * missing characters, unreadable source). */
export class GraphicsError extends Data.TaggedError("GraphicsError")<{ readonly detail: string }> {
  get message(): string {
    return this.detail;
  }
}

/** Typed failure for generated-deck inputs and the pinned source checksum. */
export class StrokeDataError extends Data.TaggedError("StrokeDataError")<{ readonly detail: string }> {
  get message(): string {
    return this.detail;
  }
}

/** Union of every typed failure the stroke extraction pipeline can emit. */
export type StrokeExtractError =
  | StrokeDataError
  | GraphicsError
  | CharacterDataError
  | SvgPathError
  | StrokeOrderError
  | FsError;

export type DeckCharacterSets = Record<DeckId, Set<string>>;

export function charactersInText(text: string): Set<string> {
  return new Set([...text]);
}

/** Collects, per deck, every character that needs stroke paths. */
export const collectDeckCharacters = (
  decks: ReadonlyMap<DeckId, RuntimeDeck>,
): Effect.Effect<DeckCharacterSets, StrokeDataError, never> =>
  Effect.gen(function* () {
    const demoCharacters = new Set(createDemoDeck("hsk-1").words.flatMap((word) => [...word.displayHanzi]));
    const result = {} as DeckCharacterSets;
    for (const id of DECK_IDS) {
      const deck = decks.get(id);
      if (!deck) {
        return yield* Effect.fail(new StrokeDataError({ detail: `Missing generated deck ${id}` }));
      }
      const characters = new Set(demoCharacters);
      for (const word of deck.words) {
        for (const character of word.displayHanzi) characters.add(character);
        // A few source definitions contain Chinese grammar examples. They are
        // visible answer text and therefore need paths in the same deck bundle.
        for (const character of word.meaning) if (HAN_CHARACTER.test(character)) characters.add(character);
      }
      for (const character of characters) {
        if (!HAN_CHARACTER.test(character) && !ALLOWED_TEXT_FALLBACK.has(character)) {
          return yield* Effect.fail(new StrokeDataError({
            detail: `Unsupported non-Hanzi character ${JSON.stringify(character)} (U+${character.codePointAt(0)?.toString(16).toUpperCase()}) in ${id}`,
          }));
        }
      }
      result[id] = characters;
    }
    return result;
  });

// Local import kept below the pure helpers to preserve the original module layout.

/** Validates one SVG path and returns it unchanged when well-formed. */
export const validateSvgPathEffect = (value: unknown, label = "stroke"): Effect.Effect<string, SvgPathError, never> =>
  Effect.gen(function* () {
    if (typeof value !== "string" || !value.trim()) {
      return yield* Effect.fail(new SvgPathError({ detail: `${label} must be a non-empty SVG path` }));
    }
    const compact = value.replace(/[\s,]+/g, "");
    const tokens = [...value.matchAll(SVG_TOKEN)];
    if (tokens.length === 0 || tokens.map((match) => match[0]).join("").replace(/[\s,]+/g, "") !== compact) {
      return yield* Effect.fail(new SvgPathError({ detail: `${label} contains invalid SVG path syntax` }));
    }
    let command = "";
    let parameterCount = 0;
    let sawMove = false;
    const finishCommand = (): Effect.Effect<void, SvgPathError, never> => {
      if (!command) return Effect.void;
      const arity = SVG_ARITY[command.toUpperCase()];
      if (arity === undefined || (arity === 0 ? parameterCount !== 0 : parameterCount === 0 || parameterCount % arity !== 0)) {
        return Effect.fail(new SvgPathError({ detail: `${label} has invalid parameters for ${command}` }));
      }
      return Effect.void;
    };
    for (const match of tokens) {
      if (match[1]) {
        yield* finishCommand();
        command = match[1];
        parameterCount = 0;
        if (command.toUpperCase() === "M") sawMove = true;
        if (!(command.toUpperCase() in SVG_ARITY)) {
          return yield* Effect.fail(new SvgPathError({ detail: `${label} uses unsupported SVG command ${command}` }));
        }
      } else {
        if (!command) {
          return yield* Effect.fail(new SvgPathError({ detail: `${label} has a number before its first command` }));
        }
        const number = Number(match[2]);
        if (!Number.isFinite(number)) {
          return yield* Effect.fail(new SvgPathError({ detail: `${label} contains a non-finite coordinate` }));
        }
        parameterCount += 1;
      }
    }
    yield* finishCommand();
    if (!sawMove) {
      return yield* Effect.fail(new SvgPathError({ detail: `${label} must contain a move command` }));
    }
    return value;
  });

/** Validates decoded Make Me a Hanzi character data (strokes + medians). */
export const validateCharacterDataEffect = (
  value: unknown,
  character: string,
): Effect.Effect<StrokeCharacterData, CharacterDataError | SvgPathError, never> =>
  Effect.gen(function* () {
    if (!value || typeof value !== "object") {
      return yield* Effect.fail(new CharacterDataError({ detail: `${character}: character data must be an object` }));
    }
    const candidate = value as { strokes?: unknown; medians?: unknown };
    if (!Array.isArray(candidate.strokes) || candidate.strokes.length === 0) {
      return yield* Effect.fail(new CharacterDataError({ detail: `${character}: strokes must be a non-empty array` }));
    }
    if (!Array.isArray(candidate.medians) || candidate.medians.length !== candidate.strokes.length) {
      return yield* Effect.fail(new CharacterDataError({ detail: `${character}: stroke and median counts differ` }));
    }
    const strokes: string[] = [];
    for (const [index, stroke] of candidate.strokes.entries()) {
      strokes.push(yield* validateSvgPathEffect(stroke, `${character} stroke ${index + 1}`));
    }
    const medians: StrokePoint[][] = [];
    for (const [strokeIndex, median] of candidate.medians.entries()) {
      if (!Array.isArray(median) || median.length < 2) {
        return yield* Effect.fail(new CharacterDataError({ detail: `${character} median ${strokeIndex + 1} needs at least two points` }));
      }
      const points: StrokePoint[] = [];
      for (const [pointIndex, point] of median.entries()) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
          return yield* Effect.fail(new CharacterDataError({
            detail: `${character} median ${strokeIndex + 1} point ${pointIndex + 1} is invalid`,
          }));
        }
        points.push([point[0] as number, point[1] as number]);
      }
      medians.push(points);
    }
    return { strokes, medians };
  });

/** Applies a reviewed stroke-order permutation to validated character data. */
export const applyStrokeOrderOverrideEffect = (
  character: string,
  data: StrokeCharacterData,
  override: StrokeOrderOverride,
): Effect.Effect<StrokeCharacterData, StrokeOrderError, never> =>
  Effect.gen(function* () {
    const expected = data.strokes.map((_, index) => index);
    if (override.strokeOrder.length !== expected.length || [...override.strokeOrder].sort((a, b) => a - b).some((value, index) => value !== index)) {
      return yield* Effect.fail(new StrokeOrderError({
        detail: `${character}: override strokeOrder must be a permutation of 0..${expected.length - 1}`,
      }));
    }
    return {
      strokes: override.strokeOrder.map((index) => data.strokes[index]!),
      medians: override.strokeOrder.map((index) => data.medians[index]!),
    };
  });

const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const sha256Text = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reads the generated runtime decks from `public/game-data`. */
export const loadGeneratedDecks = (
  rootDir: string,
): Effect.Effect<Map<DeckId, RuntimeDeck>, StrokeDataError | FsError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const decks = new Map<DeckId, RuntimeDeck>();
    for (const id of DECK_IDS) {
      const filePath = path.join(rootDir, "public", "game-data", id, "deck.json");
      const text = yield* fs.readTextFile(filePath);
      decks.set(
        id,
        yield* Effect.try({
          try: () => RuntimeDeckSchema.parse(JSON.parse(text)),
          catch: (error) => new StrokeDataError({ detail: error instanceof Error ? error.message : String(error) }),
        }),
      );
    }
    return decks;
  });

type GraphicsScanState = {
  lineNumber: number;
  characters: Map<string, StrokeCharacterData>;
  appliedOverrides: StrokeBundleManifest["appliedOverrides"];
};

type GraphicsScanError = GraphicsError | CharacterDataError | SvgPathError | StrokeOrderError;

const scanGraphicsLine = (required: ReadonlySet<string>, overrides: StrokeOverrides) =>
  (state: GraphicsScanState, line: string): Effect.Effect<GraphicsScanState, GraphicsScanError, never> =>
    Effect.gen(function* () {
      state.lineNumber += 1;
      if (!line.trim()) return state;
      const raw: unknown = yield* Effect.try({
        try: () => JSON.parse(line),
        catch: (error) => new GraphicsError({ detail: `Invalid JSON at graphics.txt line ${state.lineNumber}: ${String(error)}` }),
      });
      if (!raw || typeof raw !== "object" || typeof (raw as { character?: unknown }).character !== "string") return state;
      const character = (raw as { character: string }).character;
      if (!required.has(character)) return state;
      if (state.characters.has(character)) {
        return yield* Effect.fail(new GraphicsError({ detail: `Duplicate graphics entry for ${character}` }));
      }
      let data = yield* validateCharacterDataEffect(raw, character);
      const override = overrides[character];
      if (override) {
        data = yield* applyStrokeOrderOverrideEffect(character, data, override);
        state.appliedOverrides.push({ character, issue: override.issue, note: override.note });
      }
      state.characters.set(character, data);
      return state;
    });

type GraphicsScanResult = {
  characters: Map<string, StrokeCharacterData>;
  appliedOverrides: StrokeBundleManifest["appliedOverrides"];
};

/** Streams graphics.txt line by line, collecting only the required characters
 * and applying reviewed stroke-order overrides along the way. The readline
 * interface and its file stream are scoped and always released. */
export const readRequiredGraphicsEffect = (
  graphicsPath: string,
  required: ReadonlySet<string>,
  overrides: StrokeOverrides,
): Effect.Effect<GraphicsScanResult, GraphicsScanError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handles = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const input = createReadStream(graphicsPath);
          const lines = createInterface({ input, crlfDelay: Infinity });
          return { input, lines };
        }),
        ({ input, lines }) =>
          Effect.sync(() => {
            lines.close();
            input.destroy();
          }),
      );
      const graphicsLines = Stream.fromAsyncIterable(
        handles.lines,
        (error) => new GraphicsError({ detail: error instanceof Error ? error.message : String(error) }),
      );
      const initialState: GraphicsScanState = { lineNumber: 0, characters: new Map(), appliedOverrides: [] };
      const finalState = yield* Stream.runFoldEffect(graphicsLines, initialState, scanGraphicsLine(required, overrides));
      const missing = [...required].filter((character) => HAN_CHARACTER.test(character) && !finalState.characters.has(character));
      if (missing.length) {
        return yield* Effect.fail(new GraphicsError({ detail: `Missing Make Me a Hanzi data for: ${missing.join(" ")}` }));
      }
      return {
        characters: finalState.characters,
        appliedOverrides: finalState.appliedOverrides.sort((a, b) => a.character.codePointAt(0)! - b.character.codePointAt(0)!),
      };
    }),
  );

/** Trims and re-bundles the pinned Make Me a Hanzi source into per-deck stroke
 * JSON files plus a manifest with checksums. */
export const extractStrokeBundles = (options: {
  graphicsPath: string;
  outputDir: string;
  decks: ReadonlyMap<DeckId, RuntimeDeck>;
  overrides: StrokeOverrides;
}): Effect.Effect<StrokeBundleManifest, StrokeExtractError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const sourceSha256 = yield* sha256FileEffect(options.graphicsPath);
    if (sourceSha256 !== STROKE_SOURCE.graphicsSha256) {
      return yield* Effect.fail(new StrokeDataError({
        detail: `graphics.txt checksum mismatch: expected ${STROKE_SOURCE.graphicsSha256}, received ${sourceSha256}`,
      }));
    }
    const byDeck = yield* collectDeckCharacters(options.decks);
    const uiCharacters = charactersInText(UI_HANZI_TEXT);
    const required = new Set([
      ...uiCharacters,
      ...DECK_IDS.flatMap((id) => [...byDeck[id]].filter((character) => HAN_CHARACTER.test(character))),
    ]);
    const { characters, appliedOverrides } = yield* readRequiredGraphicsEffect(options.graphicsPath, required, options.overrides);
    yield* fs.mkdirRecursive(options.outputDir);
    const bundles = {} as StrokeBundleManifest["bundles"];
    const writeBundle = (id: DeckId | "ui", selectedCharacters: ReadonlySet<string>): Effect.Effect<void, FsError, never> =>
      Effect.gen(function* () {
        const selected: Record<string, StrokeCharacterData> = {};
        const sorted = [...selectedCharacters].filter((character) => characters.has(character)).sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
        for (const character of sorted) selected[character] = characters.get(character)!;
        const bundle: StrokeBundle = {
          schemaVersion: 1,
          sourceCommit: STROKE_SOURCE.commit,
          sourceSha256: STROKE_SOURCE.graphicsSha256,
          characters: selected,
        };
        const content = jsonLine(bundle);
        yield* fs.writeFile(path.join(options.outputDir, `${id}.json`), content);
        bundles[id] = { characterCount: sorted.length, bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
      });
    yield* writeBundle("ui", uiCharacters);
    for (const id of DECK_IDS) yield* writeBundle(id, byDeck[id]);
    const manifest: StrokeBundleManifest = {
      schemaVersion: 1,
      source: { ...STROKE_SOURCE },
      extractionDate: EXTRACTION_DATE,
      uniqueCharacterCount: characters.size,
      appliedOverrides,
      qualityReviews: [{
        characters: ["愿", "割"],
        issue: "https://github.com/skishore/makemeahanzi/issues/90",
        decision: "Retain the pinned upstream medians. The report provides no reviewed replacement data; these characters remain visual-regression cases and the faint guide limits gameplay impact.",
      }],
      bundles,
    };
    yield* fs.writeFile(path.join(options.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  });

// --- compatibility boundaries -------------------------------------------------
// The original module API was sync-throwing / Promise-based and is preserved for
// the test suite; the Effect implementations above carry the typed errors.

/** Synchronous boundary with the original type-guard signature. */
export function validateSvgPath(value: unknown, label = "stroke"): asserts value is string {
  Effect.runSync(validateSvgPathEffect(value, label));
}

/** Synchronous boundary: throws the typed validation error on failure. */
export function validateCharacterData(value: unknown, character: string): StrokeCharacterData {
  return Effect.runSync(validateCharacterDataEffect(value, character));
}

/** Synchronous boundary: throws the typed `StrokeOrderError` on failure. */
export function applyStrokeOrderOverride(
  character: string,
  data: StrokeCharacterData,
  override: StrokeOrderOverride,
): StrokeCharacterData {
  return Effect.runSync(applyStrokeOrderOverrideEffect(character, data, override));
}

/** Promise boundary: rejects with `FsError` on failure. */
export const sha256File = (filePath: string): Promise<string> => Effect.runPromise(sha256FileEffect(filePath));

/** Promise boundary: rejects with a typed graphics-scan error on failure. */
export const readRequiredGraphics = (
  graphicsPath: string,
  required: ReadonlySet<string>,
  overrides: StrokeOverrides,
): Promise<GraphicsScanResult> => Effect.runPromise(readRequiredGraphicsEffect(graphicsPath, required, overrides));
