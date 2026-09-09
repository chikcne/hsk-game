export const DECK_IDS = ["hsk-1", "hsk-2", "hsk-3", "hsk-4", "hsk-5", "hsk-6"] as const;
export type DeckId = (typeof DECK_IDS)[number];
/** Unique card counts per grade AFTER the keyed curriculum collapses
 * duplicate card IDs to their earliest occurrence (5396 total). */
export const DECK_TOTALS: Record<DeckId, number> = {
  "hsk-1": 352, "hsk-2": 210, "hsk-3": 567,
  "hsk-4": 1028, "hsk-5": 1533, "hsk-6": 1706,
};
export const CHOICE_KEYS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];
export const BASE_TRAVEL_MS = 24_000;
export const MAX_ACTIVE_ENEMIES = 32;
export const DANGER_ZONE_PROGRESS = 0.82;

/** Arcade-facing settings only. Battle tuning parameters (learning slots,
 * category boundaries, mastery delta, Hill curve, asymptotic shares) live in
 * the server's YAML-backed battle config, served as `battleConfig` (see
 * src/shared/battle.ts). */
export const DEFAULT_SETTINGS = {
  spawnIntervalMs: 5000,
  enemySpeedMultiplier: 0.9,
  levelSize: 20,
  reviewSessionLength: 200,
  desktopReviewMode: "typing",
  mobileReviewMode: "selection",
  masterVolume: 0.8,
  reducedMotion: false,
} as const;
