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
/** Active-thinking window before a landing target may autocomplete pinyin, and
 * the neutral thinking-time reference for the performance multiplier. */
export const RECALL_WINDOW_MS = 8000;

/** Gameplay-only settings. Spaced-repetition behavior is fixed by the
 * constants in src/domain/learning and is intentionally not tunable. */
export const DEFAULT_SETTINGS = {
  spawnIntervalMs: 5000,
  enemySpeedMultiplier: 0.9,
  masterVolume: 0.8,
  reducedMotion: false,
  levelSize: 20,
} as const;
