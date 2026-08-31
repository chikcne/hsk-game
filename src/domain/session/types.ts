import type { ChoiceKey } from "../../shared/constants";
export type EncounterOutcome =
  | { kind: "correct"; pinyinMs: number; meaningMs: number }
  | { kind: "wrongPinyin"; pinyinMs: number }
  | { kind: "wrongMeaning"; pinyinMs: number; meaningMs: number }
  | { kind: "landed"; activeThinkingMs: number | null };
export type Enemy = {
  id: string;
  wordId: string;
  progress: number;
  /** Word-mastery speed factor; the global settings multiplier is separate. */
  speedMultiplier: number;
  lane: number;
  spawnOrdinal: number;
  /** Active-recall clock value when the target first exhausted its pinyin
   * window. It remains answerable during the autocomplete grace period. */
  pinyinTimeoutStartedAtMs?: number;
  status: "descending" | "resolved";
};
export type SessionPhase = "waiting" | "pinyin" | "meaning" | "feedback" | "paused";
export type SessionEvent =
 | { type: "pinyinSubmitted"; raw: string; atMs: number }
 | { type: "meaningSelected"; key: ChoiceKey; atMs: number }
 | { type: "enemyLanded"; enemyId: string; atMs: number }
 | { type: "pause" } | { type: "resume" } | { type: "end" };
