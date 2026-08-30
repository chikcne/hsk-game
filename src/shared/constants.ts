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

/** Learning defaults are deliberately explicit so every tuning value can be
 * changed from Settings without changing scheduler code. */
export const DEFAULT_SETTINGS = {
  spawnIntervalMs: 5000,
  enemySpeedMultiplier: 0.9,
  masterVolume: 0.8,
  reducedMotion: false,
  levelSize: 20,
  struggleThresholdMs: 8000,
  correctRepeatBasePhrases: 20,
  pinyinSecondsPerPhrase: 1,
  minimumCorrectRepeatPhrases: 1,
  mistakeRepeatPhrases: 5,
  masteryCorrectDecrease: 25,
  masteryStruggleIncrease: 15,
  masteryMistakeIncrease: 40,
  repairRepetitions: 3,
  reviewInitialInterval: 10,
  reviewGraduatingInterval: 30,
  reviewLapseInterval: 5,
  reviewEasyMultiplier: 2.5,
  reviewHardMultiplier: 0.8,
  recallScoreSmoothing: 0.3,
} as const;
