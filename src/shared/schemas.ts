import { z } from "zod";
import { CHOICE_KEYS, DECK_IDS } from "./constants";

export const DeckIdSchema = z.enum(DECK_IDS);
export const ChoiceKeySchema = z.enum(CHOICE_KEYS);
export const SettingsSchema = z.object({
  spawnIntervalMs: z.number().int().min(1500).max(10_000),
  enemySpeedMultiplier: z.number().min(0.65).max(1.5),
  levelSize: z.number().int().min(5).max(100),
  masterVolume: z.number().min(0).max(1),
  reducedMotion: z.boolean(),
});
export type DifficultySettings = z.infer<typeof SettingsSchema>;

export const RuntimeWordSchema = z.object({
  id: z.string().min(1), sourceGuids: z.array(z.string()), displayHanzi: z.string().min(1),
  hanziKey: z.string().min(1), displayPinyin: z.string().min(1), acceptedPinyin: z.array(z.string().min(1)).min(1),
  partOfSpeech: z.string().nullable(), partOfSpeechKey: z.string().nullable(), senseLabel: z.string().nullable(),
  meaning: z.string().min(1), meaningKey: z.string().min(1),
  example: z.object({ hanzi: z.string(), pinyin: z.string(), meaning: z.string() }).nullable(),
  audioUrl: z.string(),
});
export type RuntimeWord = z.infer<typeof RuntimeWordSchema>;
export const MeaningIndexEntrySchema = z.object({
  label: z.string(), wordIds: z.array(z.string()), hanziKeys: z.array(z.string()), partOfSpeechKeys: z.array(z.string()),
});
export const RuntimeDeckSchema = z.object({
  schemaVersion: z.literal(1), importerVersion: z.string(), id: DeckIdSchema,
  hskLevel: z.number().int().min(1).max(6), title: z.string(), fingerprint: z.string(),
  source: z.object({ sharedId: z.number(), url: z.string(), packageSha256: z.string(), sourceNoteCount: z.number().int(), logicalWordCount: z.number().int() }),
  words: z.array(RuntimeWordSchema), meaningIndex: z.record(MeaningIndexEntrySchema),
  meaningKeysByPartOfSpeech: z.record(z.array(z.string())), allMeaningKeys: z.array(z.string()),
});
export type RuntimeDeck = z.infer<typeof RuntimeDeckSchema>;

/** One FSRS memory state for a single tested component (pinyin recall or
 * meaning recognition). Fields mirror the ts-fsrs Card so a save round-trips
 * through the scheduler exactly; dates are stored as ISO strings. */
export const ComponentMemorySchema = z.object({
  state: z.enum(["new", "learning", "review", "relearning"]),
  due: z.string(),
  stability: z.number().min(0),
  difficulty: z.number().min(0).max(10),
  elapsedDays: z.number().min(0),
  scheduledDays: z.number().min(0),
  learningSteps: z.number().int().min(0),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  lastReview: z.string().nullable(),
});
export type ComponentMemory = z.infer<typeof ComponentMemorySchema>;

export const WordProgressSchema = z.object({
  pinyin: ComponentMemorySchema,
  meaning: ComponentMemorySchema,
  attempts: z.number().int().nonnegative(),
  completeCorrect: z.number().int().nonnegative(), wrongPinyin: z.number().int().nonnegative(),
  wrongMeaning: z.number().int().nonnegative(), landed: z.number().int().nonnegative(),
  totalThinkingMs: z.number().nonnegative(), fastestCorrectMs: z.number().nonnegative().nullable(),
  totalPinyinMs: z.number().nonnegative(), fastestPinyinMs: z.number().nonnegative().nullable(),
  lastPinyinMs: z.number().nonnegative().nullable(),
  lastOutcome: z.enum(["correct", "wrongPinyin", "wrongMeaning", "landed"]).nullable(),
  lastSeenAt: z.string().nullable(), introducedAtOrdinal: z.number().int().nonnegative().nullable(),
  lastSpawnOrdinal: z.number().int().nonnegative().nullable(),
  /** Absolute spawn ordinal after which the word may spawn again. Microspacing
   * is a hard constraint: the scheduler never selects a cooling word. */
  nextEligibleSpawn: z.number().int().nonnegative(),
});
export type WordProgress = z.infer<typeof WordProgressSchema>;

export const LevelProgressSchema = z.object({
  deckId: DeckIdSchema, deckFingerprint: z.string(),
  curriculumSeed: z.string(), curriculumCursor: z.number().int().nonnegative(),
  firstCompletedAt: z.string().nullable(),
  words: z.record(WordProgressSchema), orphanedProgress: z.record(WordProgressSchema),
});
export type LevelProgress = z.infer<typeof LevelProgressSchema>;

export const LifetimeSchema = z.object({
  score: z.number().int().nonnegative(), resolvedEnemies: z.number().int().nonnegative(), completeCorrect: z.number().int().nonnegative(),
  wrongPinyin: z.number().int().nonnegative(), wrongMeaning: z.number().int().nonnegative(), landed: z.number().int().nonnegative(),
  bestStreak: z.number().int().nonnegative(), totalThinkingMs: z.number().nonnegative(),
});
export const SaveFileSchema = z.object({
  schemaVersion: z.literal(3), profileId: z.literal("default"), revision: z.number().int().nonnegative(), savedAt: z.string(),
  settings: SettingsSchema,
  /** Global spawn counter shared by every mode, so a word's cooldown survives
   * crossings between regular and review sessions. */
  spawnOrdinal: z.number().int().nonnegative(),
  schedulerRng: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]),
  levels: z.record(DeckIdSchema, LevelProgressSchema), lifetime: LifetimeSchema,
});
export type SaveFile = z.infer<typeof SaveFileSchema>;
