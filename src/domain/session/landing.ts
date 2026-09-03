import type { Enemy } from "./types";

export const PINYIN_AUTOCOMPLETE_DELAY_MS = 2_000;
export const AUTOCOMPLETE_RELIEF_PROGRESS = 0.25;
/** Unaided pinyin recall window before the autocomplete grace period begins.
 * Deliberately hardcoded: it defines the game's difficulty, not the SRS. */
export const PINYIN_RECALL_WINDOW_MS = 8_000;

export function moveEnemiesUp(enemies: readonly Enemy[]): Enemy[] {
  return enemies.map((enemy) => ({
    ...enemy,
    progress: Math.max(0, enemy.progress - AUTOCOMPLETE_RELIEF_PROGRESS),
  }));
}

export type LandingAdvance = {
  active: Enemy[];
  /** Retained for callers that report natural landings. Pinyin timeouts now
   * autocomplete instead, so this is normally empty. */
  landed: Enemy[];
  autocompleted: Enemy[];
};

/**
 * Advances enemies while guaranteeing that altitude cannot shorten the active
 * target's pinyin-recall window. When that window expires at the landing line,
 * a two-second grace period begins. The target is then autocompleted and every
 * enemy is pushed back by 25% of the field to give the player time to recover.
 * Accepted pinyin also prevents meaning-selection time from causing a timeout.
 */
export function advanceEnemiesForRecallWindow(
  enemies: readonly Enemy[],
  advance: number,
  targetId: string | null,
  phase: "pinyin" | "meaning",
  activeRecallMs: number,
  minimumRecallMs: number,
): LandingAdvance {
  const advanced = enemies.map((enemy) => {
    const next = {
      ...enemy,
      progress: Math.min(1, enemy.progress + advance * enemy.speedMultiplier),
    };
    if (
      next.id === targetId
      && phase === "pinyin"
      && next.progress >= 1
      && activeRecallMs >= minimumRecallMs
      && next.pinyinTimeoutStartedAtMs === undefined
    ) {
      next.pinyinTimeoutStartedAtMs = activeRecallMs;
    }
    return next;
  });
  const autocompleted = advanced.filter((enemy) =>
    enemy.id === targetId
    && phase === "pinyin"
    && enemy.pinyinTimeoutStartedAtMs !== undefined
    && activeRecallMs - enemy.pinyinTimeoutStartedAtMs >= PINYIN_AUTOCOMPLETE_DELAY_MS,
  );
  const active = autocompleted.length === 0 ? advanced : moveEnemiesUp(advanced);
  return { active, landed: [], autocompleted };
}
