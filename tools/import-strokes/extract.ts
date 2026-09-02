import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { DECK_IDS, type DeckId } from "../../src/shared/constants";
import { RuntimeDeckSchema, type RuntimeDeck } from "../../src/shared/schemas";
import { createDemoDeck } from "../../src/client/data/demoDeck";
import type {
  StrokeBundle,
  StrokeBundleManifest,
  StrokeCharacterData,
  StrokeOrderOverride,
  StrokeOverrides,
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
export const UI_HANZI_TEXT = "字多多汉续习第课开始一二三四五六级基础词卷日常进阶长篇高通达成温故跨复待选择纸签释义次新当前";
const ALLOWED_TEXT_FALLBACK = new Set(["·", "・", "—", "–", "-", "…", "（", "）", "(", ")"]);
const SVG_TOKEN = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
const SVG_ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export type DeckCharacterSets = Record<DeckId, Set<string>>;

export function charactersInText(text: string): Set<string> {
  return new Set([...text]);
}

export function collectDeckCharacters(decks: ReadonlyMap<DeckId, RuntimeDeck>): DeckCharacterSets {
  const demoCharacters = new Set(createDemoDeck("hsk-1").words.flatMap((word) => [...word.displayHanzi]));
  const result = {} as DeckCharacterSets;
  for (const id of DECK_IDS) {
    const deck = decks.get(id);
    if (!deck) throw new Error(`Missing generated deck ${id}`);
    const characters = new Set(demoCharacters);
    for (const word of deck.words) {
      for (const character of word.displayHanzi) characters.add(character);
      // A few source definitions contain Chinese grammar examples. They are
      // visible answer text and therefore need paths in the same deck bundle.
      for (const character of word.meaning) if (HAN_CHARACTER.test(character)) characters.add(character);
    }
    for (const character of characters) {
      if (!HAN_CHARACTER.test(character) && !ALLOWED_TEXT_FALLBACK.has(character)) {
        throw new Error(`Unsupported non-Hanzi character ${JSON.stringify(character)} (U+${character.codePointAt(0)?.toString(16).toUpperCase()}) in ${id}`);
      }
    }
    result[id] = characters;
  }
  return result;
}

export function validateSvgPath(value: unknown, label = "stroke"): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty SVG path`);
  const compact = value.replace(/[\s,]+/g, "");
  const tokens = [...value.matchAll(SVG_TOKEN)];
  if (tokens.length === 0 || tokens.map((match) => match[0]).join("").replace(/[\s,]+/g, "") !== compact) {
    throw new Error(`${label} contains invalid SVG path syntax`);
  }
  let command = "";
  let parameterCount = 0;
  let sawMove = false;
  const finishCommand = () => {
    if (!command) return;
    const arity = SVG_ARITY[command.toUpperCase()];
    if (arity === undefined || (arity === 0 ? parameterCount !== 0 : parameterCount === 0 || parameterCount % arity !== 0)) {
      throw new Error(`${label} has invalid parameters for ${command}`);
    }
  };
  for (const match of tokens) {
    if (match[1]) {
      finishCommand();
      command = match[1];
      parameterCount = 0;
      if (command.toUpperCase() === "M") sawMove = true;
      if (!(command.toUpperCase() in SVG_ARITY)) throw new Error(`${label} uses unsupported SVG command ${command}`);
    } else {
      if (!command) throw new Error(`${label} has a number before its first command`);
      const number = Number(match[2]);
      if (!Number.isFinite(number)) throw new Error(`${label} contains a non-finite coordinate`);
      parameterCount += 1;
    }
  }
  finishCommand();
  if (!sawMove) throw new Error(`${label} must contain a move command`);
}

export function validateCharacterData(value: unknown, character: string): StrokeCharacterData {
  if (!value || typeof value !== "object") throw new Error(`${character}: character data must be an object`);
  const candidate = value as { strokes?: unknown; medians?: unknown };
  if (!Array.isArray(candidate.strokes) || candidate.strokes.length === 0) throw new Error(`${character}: strokes must be a non-empty array`);
  if (!Array.isArray(candidate.medians) || candidate.medians.length !== candidate.strokes.length) throw new Error(`${character}: stroke and median counts differ`);
  const strokes = candidate.strokes.map((stroke, index) => {
    validateSvgPath(stroke, `${character} stroke ${index + 1}`);
    return stroke;
  });
  const medians = candidate.medians.map((median, strokeIndex) => {
    if (!Array.isArray(median) || median.length < 2) throw new Error(`${character} median ${strokeIndex + 1} needs at least two points`);
    return median.map((point, pointIndex) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
        throw new Error(`${character} median ${strokeIndex + 1} point ${pointIndex + 1} is invalid`);
      }
      return [point[0] as number, point[1] as number] as [number, number];
    });
  });
  return { strokes, medians };
}

export function applyStrokeOrderOverride(character: string, data: StrokeCharacterData, override: StrokeOrderOverride): StrokeCharacterData {
  const expected = data.strokes.map((_, index) => index);
  if (override.strokeOrder.length !== expected.length || [...override.strokeOrder].sort((a, b) => a - b).some((value, index) => value !== index)) {
    throw new Error(`${character}: override strokeOrder must be a permutation of 0..${expected.length - 1}`);
  }
  return {
    strokes: override.strokeOrder.map((index) => data.strokes[index]!),
    medians: override.strokeOrder.map((index) => data.medians[index]!),
  };
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function readRequiredGraphics(
  graphicsPath: string,
  required: ReadonlySet<string>,
  overrides: StrokeOverrides,
): Promise<{ characters: Map<string, StrokeCharacterData>; appliedOverrides: StrokeBundleManifest["appliedOverrides"] }> {
  const characters = new Map<string, StrokeCharacterData>();
  const appliedOverrides: StrokeBundleManifest["appliedOverrides"] = [];
  const input = createInterface({ input: createReadStream(graphicsPath), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of input) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch (error) { throw new Error(`Invalid JSON at graphics.txt line ${lineNumber}: ${String(error)}`); }
    if (!raw || typeof raw !== "object" || typeof (raw as { character?: unknown }).character !== "string") continue;
    const character = (raw as { character: string }).character;
    if (!required.has(character)) continue;
    if (characters.has(character)) throw new Error(`Duplicate graphics entry for ${character}`);
    let data = validateCharacterData(raw, character);
    const override = overrides[character];
    if (override) {
      data = applyStrokeOrderOverride(character, data, override);
      appliedOverrides.push({ character, issue: override.issue, note: override.note });
    }
    characters.set(character, data);
  }
  const missing = [...required].filter((character) => HAN_CHARACTER.test(character) && !characters.has(character));
  if (missing.length) throw new Error(`Missing Make Me a Hanzi data for: ${missing.join(" ")}`);
  return { characters, appliedOverrides: appliedOverrides.sort((a, b) => a.character.codePointAt(0)! - b.character.codePointAt(0)!) };
}

const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const sha256Text = (value: string) => createHash("sha256").update(value).digest("hex");

export async function loadGeneratedDecks(rootDir: string): Promise<Map<DeckId, RuntimeDeck>> {
  const decks = new Map<DeckId, RuntimeDeck>();
  for (const id of DECK_IDS) {
    const filePath = path.join(rootDir, "public", "game-data", id, "deck.json");
    decks.set(id, RuntimeDeckSchema.parse(JSON.parse(await readFile(filePath, "utf8"))));
  }
  return decks;
}

export async function extractStrokeBundles(options: {
  graphicsPath: string;
  outputDir: string;
  decks: ReadonlyMap<DeckId, RuntimeDeck>;
  overrides: StrokeOverrides;
}): Promise<StrokeBundleManifest> {
  const sourceSha256 = await sha256File(options.graphicsPath);
  if (sourceSha256 !== STROKE_SOURCE.graphicsSha256) {
    throw new Error(`graphics.txt checksum mismatch: expected ${STROKE_SOURCE.graphicsSha256}, received ${sourceSha256}`);
  }
  const byDeck = collectDeckCharacters(options.decks);
  const uiCharacters = charactersInText(UI_HANZI_TEXT);
  const required = new Set([
    ...uiCharacters,
    ...DECK_IDS.flatMap((id) => [...byDeck[id]].filter((character) => HAN_CHARACTER.test(character))),
  ]);
  const { characters, appliedOverrides } = await readRequiredGraphics(options.graphicsPath, required, options.overrides);
  await mkdir(options.outputDir, { recursive: true });
  const bundles = {} as StrokeBundleManifest["bundles"];
  const writeBundle = async (id: DeckId | "ui", selectedCharacters: ReadonlySet<string>) => {
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
    await writeFile(path.join(options.outputDir, `${id}.json`), content);
    bundles[id] = { characterCount: sorted.length, bytes: Buffer.byteLength(content), sha256: sha256Text(content) };
  };
  await writeBundle("ui", uiCharacters);
  for (const id of DECK_IDS) await writeBundle(id, byDeck[id]);
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
  await writeFile(path.join(options.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
