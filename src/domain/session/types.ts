import type { ChoiceKey } from "../../shared/constants";
export type EncounterOutcome =
  | { kind: "correct"; pinyinMs: number; meaningMs: number }
  | { kind: "wrongPinyin"; pinyinMs: number }
  | { kind: "wrongMeaning"; pinyinMs: number; meaningMs: number };
export type Enemy = {
  id: string;
  wordId: string;
  progress: number;
  /** Word-familiarity speed factor; the global settings multiplier is separate. */
  speedMultiplier: number;
  /** True when this encounter spawned at 0% familiarity (never reviewed). */
  isNewWord: boolean;
  lane: number;
  spawnOrdinal: number;
  /** Battlefield slot this word occupies. At most one live word per column:
   * see `nextFreeColumnSlot` in ./columns. */
  columnSlot: number;
  /** Pre-spawn write cadence multiplier (1 = natural). Only a preparing enemy
   * carries it: on an empty battlefield the stroke animation compresses so the
   * word is playable within the two-second empty-field budget. Gameplay
   * rendering ignores it because live phrases are static SVG. */
  writeSpeed?: number;
  status: "descending" | "resolved";
};
export type SessionPhase = "waiting" | "pinyin" | "meaning" | "feedback" | "paused";
export type SessionEvent =
 | { type: "pinyinSubmitted"; raw: string; atMs: number }
 | { type: "meaningSelected"; key: ChoiceKey; atMs: number }
 | { type: "enemyVanished"; enemyId: string; atMs: number }
 | { type: "pause" } | { type: "resume" } | { type: "end" };
