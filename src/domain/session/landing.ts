import type { Enemy } from "./types";

/** Lifts every given word by `relief` of the full descent (never above the
 * top of the field). Applied to the words left standing after a correct
 * answer. */
export function moveEnemiesUp(enemies: readonly Enemy[], relief: number): Enemy[] {
  if (relief <= 0) return [...enemies];
  return enemies.map((enemy) => ({
    ...enemy,
    progress: Math.max(0, enemy.progress - relief),
  }));
}

export type LandingAdvance = {
  active: Enemy[];
  /** Words that reached the ground this frame. Reaching the ground is not an
   * encounter outcome: the word silently disappears, nothing is revealed, and
   * mastery does not move. */
  vanished: Enemy[];
};

/**
 * Advances every word by its own speed factor and drops the ones that reach
 * the ground. Altitude carries no penalty and no time pressure of its own —
 * the answer timer, not the landing line, decides when an unanswered word
 * escalates to second chance.
 */
export function advanceEnemies(enemies: readonly Enemy[], advance: number): LandingAdvance {
  const active: Enemy[] = [];
  const vanished: Enemy[] = [];
  for (const enemy of enemies) {
    const progress = enemy.progress + advance * enemy.speedMultiplier;
    if (progress >= 1) vanished.push({ ...enemy, progress: 1 });
    else active.push({ ...enemy, progress });
  }
  return { active, vanished };
}
