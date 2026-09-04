import { z } from "zod";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import {
  LearnSessionSchema, LevelProgressSchema, LifetimeSchema, RelearnCardStateSchema, RelearnSessionSchema, SaveFileSchema,
  SettingsSchema, WordProgressSchema,
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
const StrictCardMemorySchema = WordProgressSchema.shape.card.extend({
  due: isoTimestamp,
  lastReview: isoTimestamp.nullable(),
}).strict();
const StrictWordProgressSchema = WordProgressSchema.extend({
  card: StrictCardMemorySchema,
  lastSeenAt: isoTimestamp.nullable(),
}).strict();
const StrictLevelProgressSchema = LevelProgressSchema.extend({
  firstCompletedAt: isoTimestamp.nullable(),
  words: z.record(z.string().min(1), StrictWordProgressSchema),
  orphanedProgress: z.record(z.string().min(1), StrictWordProgressSchema),
}).strict();
const StrictLearnSessionSchema = LearnSessionSchema.extend({
  startedAt: isoTimestamp,
}).strict();
const StrictRelearnCardStateSchema = RelearnCardStateSchema.extend({
  card: StrictCardMemorySchema,
}).strict();
const StrictRelearnSessionSchema = RelearnSessionSchema.extend({
  startedAt: isoTimestamp,
  cards: z.record(z.string().min(1), StrictRelearnCardStateSchema),
}).strict();
const StrictLifetimeSchema = LifetimeSchema.strict();

/** `deckId:wordId` — the cross-grade identity used by the review deck and the
 * `acquired_words` table. */
const AcquiredKeySchema = z.string().refine(
  (key) => {
    const separator = key.indexOf(":");
    return separator > 0 && (DECK_IDS as readonly string[]).includes(key.slice(0, separator)) && key.length > separator + 1;
  },
  { message: "acquired word keys must be `<deckId>:<wordId>`" },
);

export const PersistedSaveSchema = SaveFileSchema.extend({
  savedAt: isoTimestamp,
  settings: StrictSettingsSchema,
  schedulerRng: rngSchema,
  levels: z.record(z.enum(DECK_IDS), StrictLevelProgressSchema),
  acquiredWords: z.array(AcquiredKeySchema),
  learnSessions: z.record(z.enum(DECK_IDS), StrictLearnSessionSchema.nullable()),
  relearnSession: StrictRelearnSessionSchema.nullable(),
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
        const memory = word.card;
        if (memory.state !== "new") {
          if (memory.lastReview === null) {
            addIssue(context, [...path, "card", "lastReview"], `a ${memory.state} card must record its last review`);
          }
          if (memory.difficulty < 1) {
            addIssue(context, [...path, "card", "difficulty"], `a ${memory.state} card must have difficulty of at least 1`);
          }
          if (memory.stability <= 0) {
            addIssue(context, [...path, "card", "stability"], `a ${memory.state} card must have positive stability`);
          }
        } else if (memory.lastReview !== null) {
          addIssue(context, [...path, "card", "lastReview"], "a new card cannot have a last review");
        }
        if (memory.lastReview !== null && Date.parse(memory.due) < Date.parse(memory.lastReview)) {
          addIssue(context, [...path, "card", "due"], "must not precede the last review");
        }
        if (word.introducedAtOrdinal !== null && word.introducedAtOrdinal > save.spawnOrdinal) {
          addIssue(context, [...path, "introducedAtOrdinal"], "cannot exceed the save's spawn ordinal");
        }
      }
    }

    // Introduction must stay behind the cursor: the cursor advances exactly
    // with (introduced) words. With a catalog the introduced count is fully
    // known (every word ID was just checked against the deck), so equality
    // is enforceable; without one, the cursor must at least cover every
    // introduced word.
    const introducedCount = Object.values(level.words).filter((word) => word.introducedAtOrdinal !== null).length;
    if (knownDeck) {
      if (level.curriculumCursor !== introducedCount) {
        addIssue(context, [...base, "curriculumCursor"], `must equal the introduced word count (${introducedCount})`);
      }
    } else if (level.curriculumCursor < introducedCount) {
      addIssue(context, [...base, "curriculumCursor"], "cannot be smaller than the introduced word count");
    }
  }

  // Sessions are validated even when their grade has no level record (a
  // session row is never silently trusted just because its level vanished).
  for (const [deckKey, session] of Object.entries(save.learnSessions) as Array<[DeckId, z.infer<typeof StrictLearnSessionSchema> | null]>) {
    if (!session) continue;
    const sessionPath = ["learnSessions", deckKey];
    const level = save.levels[deckKey];
    if (level) {
      if (session.deckId !== deckKey) addIssue(context, [...sessionPath, "deckId"], "must match its learnSessions record key");
      if (session.deckFingerprint !== level.deckFingerprint) {
        addIssue(context, [...sessionPath, "deckFingerprint"], "must match the level's deck fingerprint");
      }
    } else if (session.deckId !== deckKey) {
      addIssue(context, [...sessionPath, "deckId"], "must match its learnSessions record key");
    }
    const memberIds = new Set(session.wordIds);
    if (memberIds.size !== session.wordIds.length) {
      addIssue(context, [...sessionPath, "wordIds"], "must not contain duplicate word IDs");
    }
    for (const [index, wordId] of session.wordIds.entries()) {
      if (level && !level.words[wordId]) addIssue(context, [...sessionPath, "wordIds", index], "member word is not present in the level record");
    }
    const completed = new Set(session.completedWordIds);
    if (completed.size !== session.completedWordIds.length) {
      addIssue(context, [...sessionPath, "completedWordIds"], "must not contain duplicate word IDs");
    }
    for (const [index, wordId] of session.completedWordIds.entries()) {
      if (!memberIds.has(wordId)) addIssue(context, [...sessionPath, "completedWordIds", index], "completed word must be a session member");
    }
  }

  const seenAcquired = new Set<string>();
  for (const [index, key] of save.acquiredWords.entries()) {
    if (seenAcquired.has(key)) addIssue(context, ["acquiredWords", index], "must not contain duplicate word keys");
    seenAcquired.add(key);
    const separator = key.indexOf(":");
    const deckKey = key.slice(0, separator) as DeckId;
    const wordId = key.slice(separator + 1);
    const level = save.levels[deckKey];
    // The word record may be temporarily orphaned by a deck update; when it
    // is present, an acquired word must be in (or recovering from) review.
    const word = level?.words[wordId];
    if (word && word.card.state !== "review" && word.card.state !== "relearning") {
      addIssue(context, ["acquiredWords", index], "an acquired word's card must be in review or relearning state");
    }
    if (word && word.learnReviews === 0) {
      addIssue(context, ["acquiredWords", index], "an acquired word must have at least one Learn rating");
    }
  }

  const relearn = save.relearnSession;
  if (relearn) {
    const basePath = ["relearnSession"];
    const memberKeys = new Set(relearn.wordKeys);
    if (memberKeys.size !== relearn.wordKeys.length) {
      addIssue(context, [...basePath, "wordKeys"], "must not contain duplicate word keys");
    }
    const acquired = new Set(save.acquiredWords);
    for (const [index, key] of relearn.wordKeys.entries()) {
      if (!AcquiredKeySchema.safeParse(key).success) {
        addIssue(context, [...basePath, "wordKeys", index], "relearn word keys must be `<deckId>:<wordId>`");
      } else if (!acquired.has(key)) {
        addIssue(context, [...basePath, "wordKeys", index], "relearn member must be an acquired word");
      }
    }
    // Every member owns exactly one independent card; no orphan cards.
    const cardKeys = new Set(Object.keys(relearn.cards));
    for (const key of cardKeys) {
      if (!memberKeys.has(key)) addIssue(context, [...basePath, "cards", key], "independent card has no session member");
    }
    for (const key of relearn.wordKeys) {
      const state = relearn.cards[key];
      if (!state) {
        addIssue(context, [...basePath, "cards", key], "session member is missing its independent card");
        continue;
      }
      const path = [...basePath, "cards", key];
      if (!Number.isInteger(state.reviews) || state.reviews < 0) {
        addIssue(context, [...path, "reviews"], "must be a nonnegative integer");
      }
      // A member whose independent card already sits in review should have
      // been removed at rating time (applyRelearnRating); persisting one
      // means the runtime leaked a finished member back into the session.
      if (state.card.state === "review") {
        addIssue(context, [...path, "card", "state"], "a member whose independent card is in review must have been removed from the session");
      }
      // Independent relearn cards follow the same shape rules as main cards,
      // but are NEVER compared against the member's main Learn card.
      const memory = state.card;
      if (memory.state === "new") {
        if (state.reviews !== 0) addIssue(context, [...path, "reviews"], "a new independent card cannot have reviews");
        if (memory.lastReview !== null) addIssue(context, [...path, "card", "lastReview"], "a new card cannot have a last review");
      } else {
        if (state.reviews < 1) addIssue(context, [...path, "reviews"], `a ${memory.state} independent card must record at least one rating`);
        if (memory.lastReview === null) {
          addIssue(context, [...path, "card", "lastReview"], `a ${memory.state} card must record its last review`);
        }
        if (memory.difficulty < 1) addIssue(context, [...path, "card", "difficulty"], `a ${memory.state} card must have difficulty of at least 1`);
        if (memory.stability <= 0) addIssue(context, [...path, "card", "stability"], `a ${memory.state} card must have positive stability`);
      }
    }
  }
}

export function parseSaveFile(input: unknown, catalog?: DeckCatalog): z.infer<typeof PersistedSaveSchema> {
  return PersistedSaveSchema.superRefine((save, context) => checkSemanticInvariants(save, context, catalog)).parse(input);
}
export function parseSaveSnapshot(input: unknown, catalog?: DeckCatalog): SaveSnapshot {
  return SaveSnapshotSchema.superRefine((save, context) => checkSemanticInvariants(save, context, catalog)).parse(input);
}
export function parseSaveRequest(input: unknown, catalog?: DeckCatalog): SaveRequest {
  const request = SaveRequestSchema.parse(input);
  return { expectedRevision: request.expectedRevision, snapshot: parseSaveSnapshot(request.snapshot, catalog) };
}
