import type { ChoiceKey } from "../../shared/constants";
export type EncounterOutcome =
  | { kind: "correct"; pinyinMs: number; meaningMs: number }
  | { kind: "wrongPinyin"; pinyinMs: number }
  | { kind: "wrongMeaning"; pinyinMs: number; meaningMs: number }
  | { kind: "landed"; activeThinkingMs: number | null };
export type Enemy = { id: string; wordId: string; progress: number; lane: number; spawnOrdinal: number; status: "descending" | "resolved" };
export type SessionPhase = "waiting" | "pinyin" | "meaning" | "feedback" | "paused";
export type SessionEvent =
 | { type: "pinyinSubmitted"; raw: string; atMs: number }
 | { type: "meaningSelected"; key: ChoiceKey; atMs: number }
 | { type: "enemyLanded"; enemyId: string; atMs: number }
 | { type: "pause" } | { type: "resume" } | { type: "end" };
