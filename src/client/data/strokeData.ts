import { Data, Effect } from "effect";
import type { DeckId } from "../../shared/constants";
import { HttpFetch, HttpFetchLive } from "../api/saves";

export type StrokeCharacterData = {
  strokes: string[];
  medians: [number, number][][];
};

export type StrokeDataMap = ReadonlyMap<string, StrokeCharacterData>;

/** Each phrase writes one stroke at a time across all of its characters.
 * A 150 ms draw plus 50 ms separation gives the requested 200 ms cadence. */
export const STROKE_DRAW_MS = 150;
export const STROKE_GAP_MS = 50;
export const STROKE_CADENCE_MS = STROKE_DRAW_MS + STROKE_GAP_MS;

export function phraseStrokeLeadMs(displayHanzi: string, data: StrokeDataMap): number {
  return [...displayHanzi].reduce((total, character) => total + (data.get(character)?.strokes.length ?? 0), 0) * STROKE_CADENCE_MS;
}

type StrokeBundle = {
  schemaVersion: 1;
  sourceCommit: string;
  sourceSha256: string;
  characters: Record<string, StrokeCharacterData>;
};

type StrokeBundleId = DeckId | "ui";

const SOURCE_COMMIT = "618dbab8a8ddefb958763c8b4afbaa741a4460de";
const SOURCE_SHA256 = "a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee";

/** The bundle at `/stroke-data/<id>.json` did not match the expected schema
 * or could not be fetched. Non-fatal: callers fall back to placeholders. */
export class StrokeBundleError extends Data.TaggedError("StrokeBundleError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

/** Validates an untrusted bundle payload against the expected schema. */
const parseBundle = (value: unknown, id: StrokeBundleId): Effect.Effect<StrokeDataMap, StrokeBundleError, never> => {
  if (!value || typeof value !== "object") {
    return Effect.fail(new StrokeBundleError({ message: `${id} stroke bundle is not an object` }));
  }
  const bundle = value as Partial<StrokeBundle>;
  if (bundle.schemaVersion !== 1 || bundle.sourceCommit !== SOURCE_COMMIT || bundle.sourceSha256 !== SOURCE_SHA256 || !bundle.characters || typeof bundle.characters !== "object") {
    return Effect.fail(new StrokeBundleError({ message: `${id} stroke bundle has incompatible metadata` }));
  }
  const result = new Map<string, StrokeCharacterData>();
  for (const [character, data] of Object.entries(bundle.characters)) {
    if (!data || !Array.isArray(data.strokes) || data.strokes.length === 0 || !Array.isArray(data.medians) || data.medians.length !== data.strokes.length) {
      return Effect.fail(new StrokeBundleError({ message: `${id} stroke data for ${character} is malformed` }));
    }
    result.set(character, data);
  }
  return Effect.succeed(result);
};

const fetchBundle = (id: StrokeBundleId): Effect.Effect<StrokeDataMap, StrokeBundleError, HttpFetch> =>
  Effect.gen(function* () {
    const fetch = yield* HttpFetch;
    const response = yield* fetch(`/stroke-data/${id}.json`).pipe(
      Effect.mapError((cause) => new StrokeBundleError({ message: `${id} stroke bundle request failed`, cause })),
    );
    if (!response.ok) {
      return yield* Effect.fail(new StrokeBundleError({ message: `HTTP ${response.status}` }));
    }
    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        new StrokeBundleError({
          message: `${id} stroke bundle is not readable JSON`,
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
    });
    return yield* parseBundle(json, id);
  });

/** First request per bundle wins (memoized, shared across callers). A failed
 * bundle is deliberately non-fatal: it logs once and falls back to an empty
 * map so the UI can retain its layout and accessible text while showing a
 * missing-glyph box. */
const bundlePrograms = new Map<StrokeBundleId, Effect.Effect<StrokeDataMap, never, HttpFetch>>();

const bundleProgram = (id: StrokeBundleId): Effect.Effect<StrokeDataMap, never, HttpFetch> => {
  const cached = bundlePrograms.get(id);
  if (cached) return cached;
  const program = Effect.runSync(Effect.cached(fetchBundle(id).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(`[stroke-data] Could not load ${id}; using vector placeholders.`, error);
        return new Map<string, StrokeCharacterData>();
      })
    ),
  )));
  bundlePrograms.set(id, program);
  return program;
};

const provideLive = <A>(program: Effect.Effect<A, never, HttpFetch>): Effect.Effect<A, never, never> =>
  Effect.provide(program, HttpFetchLive);

export const loadStrokeBundleEffect = (
  id: DeckId,
): Effect.Effect<StrokeDataMap, never, never> => provideLive(bundleProgram(id));

export const loadUiStrokeBundleEffect: Effect.Effect<StrokeDataMap, never, never> =
  provideLive(bundleProgram("ui"));

export const loadStrokeBundle = (id: DeckId): Promise<StrokeDataMap> =>
  Effect.runPromise(loadStrokeBundleEffect(id));

export const loadUiStrokeBundle = (): Promise<StrokeDataMap> =>
  Effect.runPromise(loadUiStrokeBundleEffect);

export function mergeStrokeData(...maps: readonly StrokeDataMap[]): StrokeDataMap {
  const merged = new Map<string, StrokeCharacterData>();
  for (const map of maps) for (const [character, data] of map) merged.set(character, data);
  return merged;
}

export const loadStrokeBundlesEffect = (
  ids: readonly DeckId[],
): Effect.Effect<StrokeDataMap, never, never> => Effect.map(
  provideLive(Effect.all(ids.map(bundleProgram), { concurrency: "unbounded" })),
  (bundles) => mergeStrokeData(...bundles),
);

export const loadStrokeBundles = (ids: readonly DeckId[]): Promise<StrokeDataMap> =>
  Effect.runPromise(loadStrokeBundlesEffect(ids));
