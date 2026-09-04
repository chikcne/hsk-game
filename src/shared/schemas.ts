import { z } from "zod";
import { CHOICE_KEYS, DECK_IDS } from "./constants";

export const DeckIdSchema = z.enum(DECK_IDS);
export const ChoiceKeySchema = z.enum(CHOICE_KEYS);
export const SettingsSchema = z.object({
  spawnIntervalMs: z.number().int().min(1500).max(10_000),
  enemySpeedMultiplier: z.number().min(0.65).max(1.5),
  /** Learn Mode: maximum brand-new curriculum words introduced per session. */
  levelSize: z.number().int().min(5).max(100),
  /** Review Mode: exact length of the nonpersisted base spawn plan. Repair
   * retries for missed words are additive on top of this target. */
  reviewSessionLength: z.number().int().min(200).max(500),
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

/** The one FSRS card for a word/phrase (the "main Learn card"). Learn Mode's
 * four explicit self-ratings apply directly to this card. Fields mirror the
 * ts-fsrs Card so a save round-trips through the scheduler exactly; dates are
 * stored as ISO strings. */
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

/** Per-word progress for one grade. The single `card` is the only memory
 * authority: it is mutated exclusively by Learn Mode's explicit ratings.
 * Review battle never writes it. The old separate pinyin/meaning memories are
 * gone (save schema v4 is a fresh start — older saves fail validation and
 * are not migrated). */
export const WordProgressSchema = z.object({
  card: ComponentMemorySchema,
  /** Count of explicit Learn ratings ever applied to the card. */
  learnReviews: z.number().int().nonnegative(),
  /** Last explicit Learn rating, ISO. Learn Mode is the ONLY writer —
   * review battles are FSRS-write-neutral and never touch word records. */
  lastSeenAt: z.string().nullable(),
  /** Global spawn ordinal at which the word entered the curriculum pool;
   * null until a Learn session introduces it (or reconciliation adds it). */
  introducedAtOrdinal: z.number().int().nonnegative().nullable(),
});
export type WordProgress = z.infer<typeof WordProgressSchema>;

export const LevelProgressSchema = z.object({
  deckId: DeckIdSchema, deckFingerprint: z.string(),
  curriculumSeed: z.string(), curriculumCursor: z.number().int().nonnegative(),
  firstCompletedAt: z.string().nullable(),
  words: z.record(WordProgressSchema), orphanedProgress: z.record(WordProgressSchema),
});
export type LevelProgress = z.infer<typeof LevelProgressSchema>;

/** One persisted active Learn session (logical table `learn_sessions`, one
 * row per grade, null when the grade has no active session). Membership is
 * frozen at creation — every currently due introduced word of the grade plus
 * up to `settings.levelSize` brand-new curriculum words — so relaunching the
 * grade resumes exactly this session. A member leaves the session only when
 * a rating leaves its card in FSRS state `review`: the rating-time removal
 * is recorded in `completedWordIds` (a due maintenance card that already sat
 * in review stays in the session until it has earned its pass). The currently
 * displayed word is persisted as `currentWordId`, so reopening a grade resumes
 * the exact card rather than recalculating it. The session completes and is
 * cleared when no members remain. */
export const LearnSessionSchema = z.object({
  deckId: DeckIdSchema,
  deckFingerprint: z.string(),
  startedAt: z.string(),
  /** Member word IDs in creation order: due words first, then new words. */
  wordIds: z.array(z.string().min(1)).min(1),
  /** Members already finished by a Review-state post-rating card. */
  completedWordIds: z.array(z.string().min(1)),
  /** Exact word currently displayed. */
  currentWordId: z.string().min(1),
});
export type LearnSession = z.infer<typeof LearnSessionSchema>;

/** One independent FSRS card + counter for a word inside the active Relearn
 * session. Deliberately separate from the main Learn card: ratings here are
 * never copied back into `levels` — the session's card is the single memory
 * authority for the relearn encounter, and finishing the word only moves its
 * key to the front of `acquired_words`. */
export const RelearnCardStateSchema = z.object({
  card: ComponentMemorySchema,
  /** Explicit ratings applied to this independent card during the session. */
  reviews: z.number().int().nonnegative(),
});
export type RelearnCardState = z.infer<typeof RelearnCardStateSchema>;

/** THE one persisted active Relearn session (logical table
 * `relearn_sessions`: at most one row, cross-grade, null when idle). Created
 * from Review summary struggle selections; membership is frozen at creation
 * and every member owns a fresh, independent single-word FSRS card. Each
 * member finishes when its independent card reaches FSRS state `review`, at
 * which moment its key is removed from the session and prepended to
 * `acquired_words` (moved to newest/front). Completion clears to null;
 * exiting preserves the session for exact resume. */
export const RelearnSessionSchema = z.object({
  startedAt: z.string(),
  /** Selected acquired word keys (`deckId:wordId`), in selection order. */
  wordKeys: z.array(z.string().min(1)).min(1),
  /** Independent card + counter per member; keys match `wordKeys` exactly. */
  cards: z.record(z.string().min(1), RelearnCardStateSchema),
});
export type RelearnSession = z.infer<typeof RelearnSessionSchema>;

/** Logical table `acquired_words`: the ordered acquisition log. A word key
 * (`deckId:wordId`, see domain/review `reviewWordKey`) enters exactly once —
 * at the moment its main Learn card first reaches FSRS state `review` — at
 * the FRONT (newest acquisition first). Later Learn ratings never reorder or
 * duplicate it. */
export const AcquiredWordKeySchema = z.string().min(1);

export const LifetimeSchema = z.object({
  score: z.number().int().nonnegative(), resolvedEnemies: z.number().int().nonnegative(), completeCorrect: z.number().int().nonnegative(),
  wrongPinyin: z.number().int().nonnegative(), wrongMeaning: z.number().int().nonnegative(), landed: z.number().int().nonnegative(),
  bestStreak: z.number().int().nonnegative(), totalThinkingMs: z.number().nonnegative(),
});
export const SaveFileSchema = z.object({
  schemaVersion: z.literal(4), profileId: z.literal("default"), revision: z.number().int().nonnegative(), savedAt: z.string(),
  settings: SettingsSchema,
  /** Global spawn counter shared by every mode; review battles still advance
   * it, and a word's introduction ordinal is recorded against it. */
  spawnOrdinal: z.number().int().nonnegative(),
  schedulerRng: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]),
  levels: z.record(DeckIdSchema, LevelProgressSchema),
  acquiredWords: z.array(AcquiredWordKeySchema),
  learnSessions: z.record(DeckIdSchema, LearnSessionSchema.nullable()),
  /** The single cross-grade active Relearn session (logical table
   * `relearn_sessions`); null when no relearn workflow is running. */
  relearnSession: RelearnSessionSchema.nullable(),
  lifetime: LifetimeSchema,
});
export type SaveFile = z.infer<typeof SaveFileSchema>;
