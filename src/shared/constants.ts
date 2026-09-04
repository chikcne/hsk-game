export const DECK_IDS = ["hsk-1", "hsk-2", "hsk-3", "hsk-4", "hsk-5", "hsk-6"] as const;
export type DeckId = (typeof DECK_IDS)[number];
export const DECK_TOTALS: Record<DeckId, number> = {
  "hsk-1": 300, "hsk-2": 200, "hsk-3": 500,
  "hsk-4": 1000, "hsk-5": 1600, "hsk-6": 1798,
};
export const CHOICE_KEYS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];
export const BASE_TRAVEL_MS = 24_000;
export const MAX_ACTIVE_ENEMIES = 32;
export const DANGER_ZONE_PROGRESS = 0.82;

/** Review Mode selection tiers over the `acquired_words` recency ranking
 * (rank 0 = newest acquisition). Ranks 0–19 ("New") are served twice per
 * base plan, ranks 20–99 ("Recent") once, and ranks 100+ ("Old") only via
 * the random filler pool. See src/domain/review/plan.ts. */
export const REVIEW_NEW_TIER_RANK_LIMIT = 20;
export const REVIEW_RECENT_TIER_RANK_LIMIT = 100;
/** A missed review word re-enters the spawn stream after this many further
 * base-plan spawns (or immediately once the base plan is exhausted). */
export const REVIEW_REPAIR_DELAY_SPAWNS = 10;

/** Arcade-facing settings only. Every long-term memory parameter (FSRS
 * weights, desired retention, learning steps) and every latency rating
 * threshold lives as a named constant in src/domain/memory so the science
 * stays out of the settings dialog. */
export const DEFAULT_SETTINGS = {
  spawnIntervalMs: 5000,
  enemySpeedMultiplier: 0.9,
  levelSize: 20,
  reviewSessionLength: 200,
  masterVolume: 0.8,
  reducedMotion: false,
} as const;
