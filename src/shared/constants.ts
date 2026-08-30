export const DECK_IDS = ["hsk-1", "hsk-2", "hsk-3", "hsk-4", "hsk-5", "hsk-6"] as const;
export type DeckId = (typeof DECK_IDS)[number];
export const DECK_TOTALS: Record<DeckId, number> = {
  "hsk-1": 300, "hsk-2": 200, "hsk-3": 500,
  "hsk-4": 1000, "hsk-5": 1600, "hsk-6": 1798,
};
export const CHOICE_KEYS = ["A", "S", "D", "F", "H", "J", "K", "L"] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];
export const BASE_TRAVEL_MS = 24_000;
export const MAX_ACTIVE_ENEMIES = 32;
export const DEFAULT_SETTINGS = {
  spawnIntervalMs: 3000,
  enemySpeedMultiplier: 1,
  masterVolume: 0.8,
  reducedMotion: false,
} as const;
