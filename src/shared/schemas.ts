import { z } from "zod";
import { CHOICE_KEYS, DECK_IDS } from "./constants";

export const DeckIdSchema = z.enum(DECK_IDS);
export const ChoiceKeySchema = z.enum(CHOICE_KEYS);
export const SettingsSchema = z.object({
  spawnIntervalMs: z.number().int().min(1500).max(10_000),
  enemySpeedMultiplier: z.number().min(0.65).max(1.5),
  masterVolume: z.number().min(0).max(1),
  reducedMotion: z.boolean(),
  levelSize: z.number().int().min(5).max(100),
});

/** Explicit SRS stage. `new` words have never been tested; `learning` words
 * walk the fixed learning steps; `relearning` words are graduated words that
 * lapsed; `review` words are graduated and scheduled by wall-clock time. */
export const WordPhaseSchema = z.enum(["new", "learning", "review", "relearning"]);
export type WordPhase = z.infer<typeof WordPhaseSchema>;
/** Continuous recall grade inferred from the encounter (replaces weight deltas). */
export const RecallGradeSchema = z.enum(["again", "hard", "good", "easy"]);
export type RecallGrade = z.infer<typeof RecallGradeSchema>;
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

export const WordProgressSchema = z.object({
  phase: WordPhaseSchema,
  /** Index into the active phase's step intervals (learning/relearning only). */
  stepIndex: z.number().int().nonnegative(),
  /** Intra-session due point, in spawn ordinals, for learning/relearning words. */
  dueOrdinal: z.number().int().nonnegative().nullable(),
  /** Wall-clock due point for graduated (review) words. */
  dueAt: z.string().nullable(),
  /** Long-term memory stability in days (graduated words). */
  stability: z.number().nonnegative(),
  /** 1 (easy) .. 10 (treacherous); shapes long-term stability growth. */
  difficulty: z.number().min(1).max(10),
  lapses: z.number().int().nonnegative(),
  lastGrade: RecallGradeSchema.nullable(),
  attempts: z.number().int().nonnegative(),
  completeCorrect: z.number().int().nonnegative(), wrongPinyin: z.number().int().nonnegative(),
  wrongMeaning: z.number().int().nonnegative(), landed: z.number().int().nonnegative(),
  totalThinkingMs: z.number().nonnegative(), fastestCorrectMs: z.number().nonnegative().nullable(),
  totalPinyinMs: z.number().nonnegative(), fastestPinyinMs: z.number().nonnegative().nullable(),
  lastPinyinMs: z.number().nonnegative().nullable(),
  lastOutcome: z.enum(["correct", "wrongPinyin", "wrongMeaning", "landed"]).nullable(),
  lastSeenAt: z.string().nullable(), introducedAtOrdinal: z.number().int().nonnegative().nullable(),
  lastSpawnOrdinal: z.number().int().nonnegative().nullable(),
  /** Hard spacing floor: this word cannot respawn before this ordinal. */
  nextEligibleSpawn: z.number().int().nonnegative(),
});
export type WordProgress = z.infer<typeof WordProgressSchema>;
export const LevelProgressSchema = z.object({
  deckId: DeckIdSchema, deckFingerprint: z.string(), nextSpawnOrdinal: z.number().int().nonnegative(),
  schedulerRng: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]),
  curriculumSeed: z.string(), curriculumCursor: z.number().int().nonnegative(),
  currentLevelIndex: z.number().int().nonnegative(), currentLevelWordIds: z.array(z.string()),
  activeLearningWordIds: z.array(z.string()), reviewedOlderWordIds: z.array(z.string()),
  firstCompletedAt: z.string().nullable(), words: z.record(WordProgressSchema), orphanedProgress: z.record(WordProgressSchema),
});
export type LevelProgress = z.infer<typeof LevelProgressSchema>;

export const ReviewWordProgressSchema = z.object({
  /** Review cards are graduated; `relearning` marks a lapsed card repeating
   * the relearning steps before its next long-term review. */
  phase: z.enum(["review", "relearning"]),
  stepIndex: z.number().int().nonnegative(),
  /** Intra-session due point for relearning cards, in spawn ordinals. */
  dueOrdinal: z.number().int().nonnegative().nullable(),
  /** Wall-clock due point for review cards. */
  dueAt: z.string().nullable(),
  stability: z.number().nonnegative(),
  difficulty: z.number().min(1).max(10),
  lapses: z.number().int().nonnegative(),
  lastGrade: RecallGradeSchema.nullable(),
  recallScoreMsPerChar: z.number().nonnegative().nullable(),
  attempts: z.number().int().nonnegative(), completeCorrect: z.number().int().nonnegative(),
  wrongPinyin: z.number().int().nonnegative(), wrongMeaning: z.number().int().nonnegative(),
  landed: z.number().int().nonnegative(), struggles: z.number().int().nonnegative(),
  totalPinyinMs: z.number().nonnegative(), lastOutcome: z.enum(["correct", "wrongPinyin", "wrongMeaning", "landed"]).nullable(),
  lastReviewedAt: z.string().nullable(), lastSpawnOrdinal: z.number().int().nonnegative().nullable(),
});
export type ReviewWordProgress = z.infer<typeof ReviewWordProgressSchema>;
export const ReviewProgressSchema = z.object({
  nextSpawnOrdinal: z.number().int().nonnegative(),
  schedulerRng: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]),
  activePoolWordKeys: z.array(z.string()), words: z.record(ReviewWordProgressSchema),
});
export type ReviewProgress = z.infer<typeof ReviewProgressSchema>;

export const LifetimeSchema = z.object({
  score: z.number().int().nonnegative(), resolvedEnemies: z.number().int().nonnegative(), completeCorrect: z.number().int().nonnegative(),
  wrongPinyin: z.number().int().nonnegative(), wrongMeaning: z.number().int().nonnegative(), landed: z.number().int().nonnegative(),
  bestStreak: z.number().int().nonnegative(), totalThinkingMs: z.number().nonnegative(),
});
export const SaveFileSchema = z.object({
  schemaVersion: z.literal(3), profileId: z.literal("default"), revision: z.number().int().nonnegative(), savedAt: z.string(),
  settings: SettingsSchema, levels: z.record(DeckIdSchema, LevelProgressSchema), review: ReviewProgressSchema, lifetime: LifetimeSchema,
});
export type SaveFile = z.infer<typeof SaveFileSchema>;
