import { z } from "zod";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import {
  LevelProgressSchema, LifetimeSchema, SaveFileSchema, SettingsSchema, WordProgressSchema, type SaveFile,
} from "../../shared/schemas";
import type { DeckCatalog } from "./manifests";

const UINT32_MAX = 0xffff_ffff;
const isoTimestamp = z.string().datetime({ offset: true });
const rngSchema = z.tuple([
  z.number().int().min(0).max(UINT32_MAX), z.number().int().min(0).max(UINT32_MAX),
  z.number().int().min(0).max(UINT32_MAX), z.number().int().min(0).max(UINT32_MAX),
]).refine((state) => state.some((word) => word !== 0), {
  message: "scheduler RNG state must not be all zero",
});

const StrictSettingsSchema = SettingsSchema.strict();
const StrictComponentMemorySchema = WordProgressSchema.shape.pinyin.extend({
  due: isoTimestamp,
  lastReview: isoTimestamp.nullable(),
}).strict();
const StrictWordProgressSchema = WordProgressSchema.extend({
  pinyin: StrictComponentMemorySchema,
  meaning: StrictComponentMemorySchema,
  lastSeenAt: isoTimestamp.nullable(),
}).strict();
const StrictLevelProgressSchema = LevelProgressSchema.extend({
  firstCompletedAt: isoTimestamp.nullable(),
  words: z.record(z.string().min(1), StrictWordProgressSchema),
  orphanedProgress: z.record(z.string().min(1), StrictWordProgressSchema),
}).strict();
const StrictLifetimeSchema = LifetimeSchema.strict();

export const PersistedSaveSchema = SaveFileSchema.extend({
  savedAt: isoTimestamp,
  settings: StrictSettingsSchema,
  schedulerRng: rngSchema,
  levels: z.record(z.enum(DECK_IDS), StrictLevelProgressSchema),
  lifetime: StrictLifetimeSchema,
}).strict();

export const SaveSnapshotSchema = PersistedSaveSchema.omit({ revision: true, savedAt: true });
export const SaveRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), snapshot: SaveSnapshotSchema }).strict();
export type SaveSnapshot = z.infer<typeof SaveSnapshotSchema>;
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function checkSemanticInvariants(save: z.infer<typeof SaveSnapshotSchema>, context: z.RefinementCtx, catalog?: DeckCatalog): void {
  const resolved = save.lifetime.completeCorrect + save.lifetime.wrongPinyin + save.lifetime.wrongMeaning + save.lifetime.landed;
  if (save.lifetime.resolvedEnemies !== resolved) addIssue(context, ["lifetime", "resolvedEnemies"], "must equal the sum of outcome counters");

  for (const [deckKey, level] of Object.entries(save.levels)) {
    if (!level) continue;
    const base = ["levels", deckKey];
    if (level.deckId !== deckKey) addIssue(context, [...base, "deckId"], "must match its levels record key");
    if (level.curriculumCursor > Object.keys(level.words).length) {
      addIssue(context, [...base, "curriculumCursor"], "cannot exceed the level word count");
    }

    const knownDeck = catalog?.get(deckKey as DeckId);
    if (knownDeck) {
      for (const wordId of Object.keys(level.words)) if (!knownDeck.wordIds.has(wordId)) addIssue(context, [...base, "words", wordId], "word ID is not present in the generated deck");
      if (level.curriculumCursor > knownDeck.wordIds.size) addIssue(context, [...base, "curriculumCursor"], "cannot exceed the generated deck word count");
    }

    for (const [collectionName, records] of [["words", level.words], ["orphanedProgress", level.orphanedProgress]] as const) {
      for (const [wordId, word] of Object.entries(records)) {
        const path = [...base, collectionName, wordId];
        const outcomes = word.completeCorrect + word.wrongPinyin + word.wrongMeaning + word.landed;
        if (word.attempts !== outcomes) addIssue(context, [...path, "attempts"], "must equal the sum of outcome counters");
        if (word.introducedAtOrdinal !== null && word.introducedAtOrdinal > save.spawnOrdinal) {
          addIssue(context, [...path, "introducedAtOrdinal"], "cannot be after the current spawn ordinal");
        }
        if (word.lastSpawnOrdinal !== null) {
          if (word.lastSpawnOrdinal >= save.spawnOrdinal) addIssue(context, [...path, "lastSpawnOrdinal"], "must be before the current spawn ordinal");
          if (word.introducedAtOrdinal === null) addIssue(context, [...path, "lastSpawnOrdinal"], "cannot precede introduction");
          else if (word.lastSpawnOrdinal < word.introducedAtOrdinal) addIssue(context, [...path, "lastSpawnOrdinal"], "must not precede introduction");
        }
        for (const component of ["pinyin", "meaning"] as const) {
          const memory = word[component];
          const memoryPath = [...path, component];
          if (memory.state !== "new") {
            if (memory.lastReview === null) {
              addIssue(context, [...memoryPath, "lastReview"], `a ${memory.state} card must record its last review`);
            }
            if (memory.difficulty < 1) {
              addIssue(context, [...memoryPath, "difficulty"], `a ${memory.state} card must have difficulty of at least 1`);
            }
            if (memory.stability <= 0) {
              addIssue(context, [...memoryPath, "stability"], `a ${memory.state} card must have positive stability`);
            }
          } else if (memory.lastReview !== null) {
            addIssue(context, [...memoryPath, "lastReview"], "a new card cannot have a last review");
          }
          if (memory.lastReview !== null && Date.parse(memory.due) < Date.parse(memory.lastReview)) {
            addIssue(context, [...memoryPath, "due"], "must not precede the last review");
          }
        }
      }
    }
  }
}

export function parseSaveFile(input: unknown, catalog?: DeckCatalog): SaveFile {
  return PersistedSaveSchema.superRefine((save, context) => checkSemanticInvariants(save, context, catalog)).parse(input);
}
export function parseSaveSnapshot(input: unknown, catalog?: DeckCatalog): SaveSnapshot {
  return SaveSnapshotSchema.superRefine((save, context) => checkSemanticInvariants(save, context, catalog)).parse(input);
}
export function parseSaveRequest(input: unknown, catalog?: DeckCatalog): SaveRequest {
  const request = SaveRequestSchema.parse(input);
  return { expectedRevision: request.expectedRevision, snapshot: parseSaveSnapshot(request.snapshot, catalog) };
}
