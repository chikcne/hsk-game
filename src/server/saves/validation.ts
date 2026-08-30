import { z } from "zod";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import {
  LevelProgressSchema, LifetimeSchema, ReviewProgressSchema, ReviewWordProgressSchema,
  SaveFileSchema, SettingsSchema, WordProgressSchema, type SaveFile,
} from "../../shared/schemas";
import type { DeckCatalog } from "./manifests";

const UINT32_MAX = 0xffff_ffff;
const isoTimestamp = z.string().datetime({ offset: true });
const rngSchema = z.tuple([
  z.number().int().min(0).max(UINT32_MAX), z.number().int().min(0).max(UINT32_MAX),
  z.number().int().min(0).max(UINT32_MAX), z.number().int().min(0).max(UINT32_MAX),
]);

const StrictSettingsSchema = SettingsSchema.strict();
const StrictWordProgressSchema = WordProgressSchema.extend({ lastSeenAt: isoTimestamp.nullable() }).strict();
const StrictLevelProgressSchema = LevelProgressSchema.extend({
  schedulerRng: rngSchema,
  firstCompletedAt: isoTimestamp.nullable(),
  words: z.record(z.string().min(1), StrictWordProgressSchema),
  orphanedProgress: z.record(z.string().min(1), StrictWordProgressSchema),
}).strict();
const StrictReviewWordProgressSchema = ReviewWordProgressSchema.extend({ lastReviewedAt: isoTimestamp.nullable() }).strict();
const StrictReviewProgressSchema = ReviewProgressSchema.extend({
  schedulerRng: rngSchema,
  words: z.record(z.string().min(1), StrictReviewWordProgressSchema),
}).strict();
const StrictLifetimeSchema = LifetimeSchema.strict();

export const PersistedSaveSchema = SaveFileSchema.extend({
  savedAt: isoTimestamp,
  settings: StrictSettingsSchema,
  levels: z.record(z.enum(DECK_IDS), StrictLevelProgressSchema),
  review: StrictReviewProgressSchema,
  lifetime: StrictLifetimeSchema,
}).strict();

export const SaveSnapshotSchema = PersistedSaveSchema.omit({ revision: true, savedAt: true });
export const SaveRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), snapshot: SaveSnapshotSchema }).strict();
export type SaveSnapshot = z.infer<typeof SaveSnapshotSchema>;
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function checkSemanticInvariants(save: z.infer<typeof SaveSnapshotSchema>, context: z.RefinementCtx, catalog?: DeckCatalog): void {
  const resolved = save.lifetime.completeCorrect + save.lifetime.wrongPinyin + save.lifetime.wrongMeaning + save.lifetime.landed;
  if (save.lifetime.resolvedEnemies !== resolved) addIssue(context, ["lifetime", "resolvedEnemies"], "must equal the sum of outcome counters");
  if (save.settings.minimumCorrectRepeatPhrases > save.settings.correctRepeatBasePhrases) {
    addIssue(context, ["settings", "minimumCorrectRepeatPhrases"], "cannot exceed correctRepeatBasePhrases");
  }

  for (const [deckKey, level] of Object.entries(save.levels)) {
    if (!level) continue;
    const base = ["levels", deckKey];
    if (level.deckId !== deckKey) addIssue(context, [...base, "deckId"], "must match its levels record key");
    const currentIds = new Set<string>();
    for (const [index, wordId] of level.currentLevelWordIds.entries()) {
      if (currentIds.has(wordId)) addIssue(context, [...base, "currentLevelWordIds", index], "current-level word IDs must be unique");
      currentIds.add(wordId);
      const word = level.words[wordId];
      if (!word) addIssue(context, [...base, "currentLevelWordIds", index], "current-level word must exist in words");
      else if (word.introducedAtOrdinal === null) addIssue(context, [...base, "currentLevelWordIds", index], "current-level word must be introduced");
    }

    const activeIds = new Set<string>();
    for (const [index, wordId] of level.activeLearningWordIds.entries()) {
      if (activeIds.has(wordId)) addIssue(context, [...base, "activeLearningWordIds", index], "active word IDs must be unique");
      activeIds.add(wordId);
      const word = level.words[wordId];
      if (!word) addIssue(context, [...base, "activeLearningWordIds", index], "active word must exist in words");
      else if (word.appearanceWeight === 1) addIssue(context, [...base, "activeLearningWordIds", index], "active word must be unmastered");
    }
    for (const wordId of currentIds) {
      if (level.words[wordId]?.appearanceWeight !== 1 && !activeIds.has(wordId)) addIssue(context, [...base, "activeLearningWordIds"], `must contain unmastered current word ${wordId}`);
    }

    const reviewed = new Set<string>();
    for (const [index, wordId] of level.reviewedOlderWordIds.entries()) {
      if (reviewed.has(wordId)) addIssue(context, [...base, "reviewedOlderWordIds", index], "reviewed older IDs must be unique");
      reviewed.add(wordId);
      if (!level.words[wordId]) addIssue(context, [...base, "reviewedOlderWordIds", index], "reviewed word must exist in words");
      if (currentIds.has(wordId)) addIssue(context, [...base, "reviewedOlderWordIds", index], "reviewed older word cannot be in current level");
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
        if (word.appearanceWeight === 1 && word.reinforcementRemaining !== 0) addIssue(context, [...path, "reinforcementRemaining"], "must be zero for a mastered word");
        if (word.introducedAtOrdinal !== null && word.introducedAtOrdinal > level.nextSpawnOrdinal) addIssue(context, [...path, "introducedAtOrdinal"], "cannot be after nextSpawnOrdinal");
        if (word.lastSpawnOrdinal !== null && word.lastSpawnOrdinal >= level.nextSpawnOrdinal) addIssue(context, [...path, "lastSpawnOrdinal"], "must be before nextSpawnOrdinal");
        if (collectionName === "words" && word.introducedAtOrdinal !== null && word.appearanceWeight > 1 && !activeIds.has(wordId)) addIssue(context, [...base, "activeLearningWordIds"], `must contain introduced unmastered word ${wordId}`);
      }
    }
  }

  const activeReviewKeys = new Set<string>();
  for (const [index, key] of save.review.activePoolWordKeys.entries()) {
    if (activeReviewKeys.has(key)) addIssue(context, ["review", "activePoolWordKeys", index], "review pool keys must be unique");
    activeReviewKeys.add(key);
    if (!save.review.words[key]) addIssue(context, ["review", "activePoolWordKeys", index], "review pool word must exist");
  }
  for (const [key, word] of Object.entries(save.review.words)) {
    const outcomes = word.completeCorrect + word.wrongPinyin + word.wrongMeaning + word.landed;
    if (word.attempts !== outcomes) addIssue(context, ["review", "words", key, "attempts"], "must equal the sum of outcome counters");
    if (word.struggles > word.attempts) addIssue(context, ["review", "words", key, "struggles"], "cannot exceed attempts");
    if (word.lastSpawnOrdinal !== null && word.lastSpawnOrdinal >= save.review.nextSpawnOrdinal) addIssue(context, ["review", "words", key, "lastSpawnOrdinal"], "must be before nextSpawnOrdinal");
    const separator = key.indexOf(":");
    const deckId = key.slice(0, separator) as DeckId;
    const wordId = key.slice(separator + 1);
    if (separator <= 0 || !DECK_IDS.includes(deckId) || wordId.length === 0) {
      addIssue(context, ["review", "words", key], "review key must be <deckId>:<wordId>");
    } else if (catalog) {
      const manifest = catalog.get(deckId);
      if (manifest && !manifest.wordIds.has(wordId)) addIssue(context, ["review", "words", key], "review word ID is not present in the generated deck");
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
