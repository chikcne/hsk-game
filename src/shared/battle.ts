import { z } from "zod";
import { SettingsSchema } from "./schemas";

/**
 * Isolated DTO layer for the Battle save contract (server SQLite at
 * `saves/default.sql`, tables `vocab` and `settings`). These schemas describe
 * EXACTLY the four approved REST endpoints and nothing else, so the client
 * battle code and the server save routes can share one definition:
 *
 * - GET  /api/saves/default                 -> BattleSaveBundle
 * - POST /api/saves/default/battle/open     -> BattleOpenResponse
 * - POST /api/saves/default/vocab/:cardId/outcome -> VocabOutcomeResponse
 * - PUT  /api/saves/default/settings        -> DifficultySettings
 *
 * The server loads the tuning parameters from config/battle.yaml at startup
 * and serves them as `battleConfig` — the ONE runtime source. There is no
 * client-side fallback: a boot that cannot reach the server fails visibly.
 */

/** One `vocab` row. `id` is the 1-based global curriculum position,
 * `card_id` the curriculum card identity (unique), `mastery` 0..100. */
export const VocabRowSchema = z.object({
  id: z.number().int().min(1),
  cardId: z.string().min(1),
  mastery: z.number().int().min(0).max(100),
  timeAdded: z.string(),
  timeMastered: z.string().nullable(),
});
export type VocabRow = z.infer<typeof VocabRowSchema>;

/** Every live-selection tuning parameter: learning slots, category
 * boundaries, the mastery delta, the Hill curve, and the asymptotic category
 * shares. Boundaries partition mastery into low (0..lowMax), developing
 * (lowMax+1..developingMax), and mastered (developingMax+1..100). */
export const BattleConfigSchema = z.object({
  /** Learning slots: how many of the lowest-id low-mastery rows stay in the
   * active pool, and how many unseen curriculum entries the refill appends
   * back up to. */
  learningSlots: z.number().int().min(1),
  boundaries: z.object({
    /** Inclusive upper bound of the low category. */
    lowMax: z.number().int().min(0).max(99),
    /** Inclusive upper bound of the developing category. */
    developingMax: z.number().int().min(1).max(99),
  }),
  /** Mastery gained on a clean correct answer and lost on any miss. */
  masteryDelta: z.number().int().min(1),
  curve: z.object({
    /** Hill midpoint: the mature-word count at which the mature share
     * reaches half of its asymptote. */
    midpoint: z.number().min(1),
    /** Hill shape exponent. */
    shape: z.number().min(0.1),
  }),
  asymptotes: z.object({
    /** Share of low-category draws as the mature pool grows unboundedly. */
    low: z.number().min(0).max(1),
    developing: z.number().min(0).max(1),
    mastered: z.number().min(0).max(1),
  }),
}).superRefine((config, ctx) => {
  const add = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (config.boundaries.lowMax >= config.boundaries.developingMax) {
    add("boundaries", "lowMax must be strictly below developingMax");
  }
  const total = config.asymptotes.low + config.asymptotes.developing + config.asymptotes.mastered;
  if (Math.abs(total - 1) > 1e-9) add("asymptotes", "asymptotic shares must sum to 1");
});
export type BattleConfig = z.infer<typeof BattleConfigSchema>;

export const BattleSaveBundleSchema = z.object({
  settings: SettingsSchema,
  vocab: z.array(VocabRowSchema),
  battleConfig: BattleConfigSchema,
});
export type BattleSaveBundle = z.infer<typeof BattleSaveBundleSchema>;

/** POST /api/saves/default/battle/open: the authoritative vocab after the
 * server atomically seeded curriculum positions 1..5 (first launch only).
 * `addedRows` lists exactly the rows appended by THIS call. */
export const BattleOpenResponseSchema = z.object({
  vocab: z.array(VocabRowSchema),
  addedRows: z.array(VocabRowSchema),
});
export type BattleOpenResponse = z.infer<typeof BattleOpenResponseSchema>;

/** POST /api/saves/default/vocab/:cardId/outcome: the authoritative row for
 * the resolved card (mastery clamped 0..100; `time_mastered` set the first
 * time mastery reaches 100) plus any refill rows appended because a low row
 * graduated and fewer than `learningSlots` low rows remained. */
export const VocabOutcomeResponseSchema = z.object({
  row: VocabRowSchema,
  addedRows: z.array(VocabRowSchema),
});
export type VocabOutcomeResponse = z.infer<typeof VocabOutcomeResponseSchema>;
