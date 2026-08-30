import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RuntimeDeckSchema, type RuntimeDeck } from "../../../src/shared/schemas";
import { type DeckId } from "../../../src/shared/constants";
import { extractArchiveEssentials, readChecksumFile, sha256File } from "../archive/zip";
import { readMediaMap } from "../archive/media";
import { readCollection } from "../sqlite/read-collection";
import { buildMeaningIndexes, normalizeAndDedupe, type Overrides, type WordAudit } from "../normalize/words";
import { extractSelectedAudio } from "./audio";
import { stableJson } from "./stable-json";

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

function parseOverrides(text: string): Overrides {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("overrides.json must be an object");
  const result: Overrides = {};
  for (const [guid, item] of Object.entries(value)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Override ${guid} must be an object`);
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.displayHanzi !== "string" || typeof candidate.reason !== "string" || !candidate.reason.trim()) {
      throw new Error(`Override ${guid} must contain displayHanzi and a nonblank reason`);
    }
    result[guid] = { displayHanzi: candidate.displayHanzi, reason: candidate.reason };
  }
  return result;
}

export type CompileOptions = {
  repositoryRoot?: string;
  outputDirectory?: string;
  deckIds?: DeckId[];
};

type CompiledDeck = { deck: RuntimeDeck; report: DeckReport; indexEntry: Record<string, unknown> };

async function compileOneDeck(
  source: DeckSource,
  repositoryRoot: string,
  outputRoot: string,
  expectedChecksum: string,
  overrides: Overrides,
  overrideSha256: string,
): Promise<CompiledDeck> {
  const apkgPath = join(repositoryRoot, "decks", source.filename);
  const packageSha256 = await sha256File(apkgPath);
  if (packageSha256 !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${source.filename}: expected ${expectedChecksum}, got ${packageSha256}`);
  }
  const extractionDirectory = await mkdtemp(join(tmpdir(), `hsk-import-${source.id}-`));
  try {
    const essentials = await extractArchiveEssentials(apkgPath, extractionDirectory);
    const collection = readCollection(essentials.collectionPath);
    if (collection.noteCount !== source.expectedSourceNotes) {
      throw new Error(`${source.id} has ${collection.noteCount} source notes; expected ${source.expectedSourceNotes}`);
    }
    const media = await readMediaMap(essentials.mediaPath);
    const normalized = normalizeAndDedupe(collection.notes, media, overrides);
    if (normalized.words.length !== source.expectedLogicalWords) {
      throw new Error(`${source.id} has ${normalized.words.length} logical words; expected ${source.expectedLogicalWords}`);
    }
    const deckOutput = join(outputRoot, source.id);
    const selectedMedia = new Map<string, string>();
    for (const word of normalized.words) selectedMedia.set(word.audioFilename, media.memberByFilename.get(word.audioFilename)!);
    const audio = await extractSelectedAudio(apkgPath, selectedMedia, join(deckOutput, "audio"));
    for (const word of normalized.words) {
      const url = audio.urlByFilename.get(word.audioFilename);
      if (!url) throw new Error(`No extracted audio URL for ${word.audioFilename}`);
      word.audioUrl = url;
    }
    const runtimeWords = normalized.words.map(({ audioFilename: _audio, sourceNoteId: _note, ...word }) => word);
    const indexes = buildMeaningIndexes(runtimeWords);
    const fingerprint = digest(`deck-v1\0${IMPORTER_VERSION}\0${packageSha256}\0${overrideSha256}`);
    const deck = RuntimeDeckSchema.parse({
      schemaVersion: 1, importerVersion: IMPORTER_VERSION, id: source.id, hskLevel: source.hskLevel,
      title: source.title, fingerprint,
      source: {
        sharedId: source.sharedId, url: `https://ankiweb.net/shared/info/${source.sharedId}`,
        packageSha256, sourceNoteCount: collection.noteCount, logicalWordCount: runtimeWords.length,
      },
      words: runtimeWords, meaningIndex: indexes.meaningIndex,
      meaningKeysByPartOfSpeech: indexes.meaningKeysByPartOfSpeech, allMeaningKeys: indexes.allMeaningKeys,
    });
    const deckJson = stableJson(deck);
    await mkdir(deckOutput, { recursive: true });
    await writeFile(join(deckOutput, "deck.json"), deckJson, { flag: "wx" });
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
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

async function atomicReplace(tempOutput: string, outputDirectory: string): Promise<void> {
  const backup = `${outputDirectory}.old-${randomUUID()}`;
  let hadPrevious = false;
  try {
    await rename(outputDirectory, backup);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(tempOutput, outputDirectory);
  } catch (error) {
    if (hadPrevious) await rename(backup, outputDirectory);
    throw error;
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true });
}

export async function compileDecks(options: CompileOptions = {}): Promise<{ decks: RuntimeDeck[]; reports: DeckReport[] }> {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
  const outputDirectory = resolve(options.outputDirectory ?? join(repositoryRoot, "public/game-data"));
  const selectedIds = options.deckIds ? new Set(options.deckIds) : null;
  const sources = DECK_SOURCES.filter((source) => !selectedIds || selectedIds.has(source.id));
  if (!sources.length) throw new Error("No decks selected");
  if (selectedIds && sources.length !== selectedIds.size) throw new Error("Unknown deck ID selected");

  const checksumByFilename = await readChecksumFile(join(repositoryRoot, "decks/SHA256SUMS"));
  const overridesPath = join(repositoryRoot, "tools/import-decks/overrides.json");
  const overridesText = await readFile(overridesPath, "utf8");
  const overrides = parseOverrides(overridesText);
  const overrideSha256 = digest(overridesText);
  await mkdir(dirname(outputDirectory), { recursive: true });
  const tempOutput = `${outputDirectory}.tmp-${randomUUID()}`;
  await mkdir(tempOutput, { recursive: true });
  try {
    const compiled: CompiledDeck[] = [];
    for (const source of sources) {
      const expected = checksumByFilename.get(source.filename);
      if (!expected) throw new Error(`No SHA-256 entry for ${source.filename}`);
      compiled.push(await compileOneDeck(source, repositoryRoot, tempOutput, expected, overrides, overrideSha256));
    }
    if (!selectedIds) {
      const applied = new Set(compiled.flatMap((item) => item.report.appliedOverrides.map((entry) => entry.guid)));
      for (const guid of Object.keys(overrides)) if (!applied.has(guid)) throw new Error(`Reviewed override GUID was not found: ${guid}`);
    }
    const index = {
      schemaVersion: 1, importerVersion: IMPORTER_VERSION,
      decks: compiled.map((item) => item.indexEntry).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    const report = {
      schemaVersion: 1, importerVersion: IMPORTER_VERSION, overrideSha256,
      decks: compiled.map((item) => item.report).sort((a, b) => a.id.localeCompare(b.id)),
    };
    await writeFile(join(tempOutput, "index.json"), stableJson(index), { flag: "wx" });
    await writeFile(join(tempOutput, "import-report.json"), stableJson(report), { flag: "wx" });
    await atomicReplace(tempOutput, outputDirectory);
    return { decks: compiled.map((item) => item.deck), reports: compiled.map((item) => item.report) };
  } catch (error) {
    await rm(tempOutput, { recursive: true, force: true });
    throw error;
  }
}

export async function checkGeneratedData(options: Omit<CompileOptions, "outputDirectory"> = {}): Promise<void> {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const repositoryRoot = resolve(options.repositoryRoot ?? defaultRoot);
  const indexPath = join(repositoryRoot, "public/game-data/index.json");
  let index: { importerVersion?: unknown; decks?: Array<{ id?: unknown; fingerprint?: unknown; deckUrl?: unknown }> };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as typeof index;
  } catch {
    throw new Error("Generated deck data is missing. Run npm run import:decks.");
  }
  if (index.importerVersion !== IMPORTER_VERSION || !Array.isArray(index.decks)) {
    throw new Error("Generated deck data is stale. Run npm run import:decks.");
  }
  const checksumByFilename = await readChecksumFile(join(repositoryRoot, "decks/SHA256SUMS"));
  const overridesText = await readFile(join(repositoryRoot, "tools/import-decks/overrides.json"), "utf8");
  const overrideSha256 = digest(overridesText);
  const selectedIds = options.deckIds ? new Set(options.deckIds) : null;
  const sources = DECK_SOURCES.filter((source) => !selectedIds || selectedIds.has(source.id));
  for (const source of sources) {
    const recordedSha256 = checksumByFilename.get(source.filename);
    const packageSha256 = await sha256File(join(repositoryRoot, "decks", source.filename));
    if (!recordedSha256 || packageSha256 !== recordedSha256) {
      throw new Error(`Source checksum mismatch for ${source.id}; generated data cannot be trusted.`);
    }
    const expectedFingerprint = digest(`deck-v1\0${IMPORTER_VERSION}\0${packageSha256}\0${overrideSha256}`);
    const entry = index.decks.find((candidate) => candidate.id === source.id);
    if (!entry || entry.fingerprint !== expectedFingerprint || entry.deckUrl !== `${source.id}/deck.json`) {
      throw new Error(`Generated ${source.id} data is stale. Run npm run import:decks.`);
    }
    const deckPath = join(repositoryRoot, "public/game-data", entry.deckUrl);
    const deck = RuntimeDeckSchema.parse(JSON.parse(await readFile(deckPath, "utf8")));
    if (deck.id !== source.id || deck.fingerprint !== expectedFingerprint || deck.words.length !== source.expectedLogicalWords) {
      throw new Error(`Generated ${source.id} deck does not match its index. Run npm run import:decks.`);
    }
    for (const word of deck.words) {
      if (!/^audio\/[a-f0-9]{64}\.mp3$/u.test(word.audioUrl)) throw new Error(`Generated ${source.id} has an unsafe audio URL.`);
      await stat(join(dirname(deckPath), word.audioUrl));
    }
  }
  await stat(indexPath);
}
