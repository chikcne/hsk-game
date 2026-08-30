import type { Enemy } from "./types";

export type LandingAdvance = {
  active: Enemy[];
  landed: Enemy[];
};

/**
 * Advances enemies while guaranteeing that altitude cannot shorten the active
 * target's pinyin-recall window. Enemies may wait at the ground until selected;
 * accepted pinyin also prevents a later meaning delay from becoming a recall
 * failure.
 */
export function advanceEnemiesForRecallWindow(
  enemies: readonly Enemy[],
  advance: number,
  targetId: string | null,
  phase: "pinyin" | "meaning",
  activeRecallMs: number,
  minimumRecallMs: number,
): LandingAdvance {
  const advanced = enemies.map((enemy) => ({
    ...enemy,
    progress: Math.min(1, enemy.progress + advance * enemy.speedMultiplier),
  }));
  const landed = advanced.filter((enemy) =>
    enemy.progress >= 1
    && enemy.id === targetId
    && phase === "pinyin"
    && activeRecallMs >= minimumRecallMs,
  );
  const landedIds = new Set(landed.map((enemy) => enemy.id));
  return { active: advanced.filter((enemy) => !landedIds.has(enemy.id)), landed };
}
