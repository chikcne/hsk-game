import type { DeckId } from "../../shared/constants";

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
const bundlePromises = new Map<StrokeBundleId, Promise<StrokeDataMap>>();
const SOURCE_COMMIT = "618dbab8a8ddefb958763c8b4afbaa741a4460de";
const SOURCE_SHA256 = "a28c478b5178e98f67f510b2d52fde08a69dc664654ef43498253b9b764d46ee";

function parseBundle(value: unknown, id: StrokeBundleId): StrokeDataMap {
  if (!value || typeof value !== "object") throw new Error(`${id} stroke bundle is not an object`);
  const bundle = value as Partial<StrokeBundle>;
  if (bundle.schemaVersion !== 1 || bundle.sourceCommit !== SOURCE_COMMIT || bundle.sourceSha256 !== SOURCE_SHA256 || !bundle.characters || typeof bundle.characters !== "object") {
    throw new Error(`${id} stroke bundle has incompatible metadata`);
  }
  const result = new Map<string, StrokeCharacterData>();
  for (const [character, data] of Object.entries(bundle.characters)) {
    if (!data || !Array.isArray(data.strokes) || data.strokes.length === 0 || !Array.isArray(data.medians) || data.medians.length !== data.strokes.length) {
      throw new Error(`${id} stroke data for ${character} is malformed`);
    }
    result.set(character, data);
  }
  return result;
}

/** Loads one local vector bundle. Failure is deliberately non-fatal so the UI
 * can retain its layout and accessible text while showing a missing-glyph box. */
function loadBundle(id: StrokeBundleId): Promise<StrokeDataMap> {
  const cached = bundlePromises.get(id);
  if (cached) return cached;
  const request = fetch(`/stroke-data/${id}.json`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseBundle(await response.json(), id);
    })
    .catch((error: unknown) => {
      console.error(`[stroke-data] Could not load ${id}; using vector placeholders.`, error);
      return new Map<string, StrokeCharacterData>();
    });
  bundlePromises.set(id, request);
  return request;
}

export const loadStrokeBundle = (id: DeckId): Promise<StrokeDataMap> => loadBundle(id);
export const loadUiStrokeBundle = (): Promise<StrokeDataMap> => loadBundle("ui");

export function mergeStrokeData(...maps: readonly StrokeDataMap[]): StrokeDataMap {
  const merged = new Map<string, StrokeCharacterData>();
  for (const map of maps) for (const [character, data] of map) merged.set(character, data);
  return merged;
}

export async function loadStrokeBundles(ids: readonly DeckId[]): Promise<StrokeDataMap> {
  const bundles = await Promise.all(ids.map(loadStrokeBundle));
  return mergeStrokeData(...bundles);
}
