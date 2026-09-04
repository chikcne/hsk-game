import type { ComponentMemory, WordProgress } from "../../shared/schemas";

/** Card familiarity in 0..1. Short-term (re)learning states sit low; review-
 * stage familiarity grows logarithmically with stability up to one year. */
export function cardFamiliarity(memory: ComponentMemory): number {
  switch (memory.state) {
    case "new": return 0;
    case "learning":
    case "relearning": return 0.25;
    case "review": {
      const scaled = Math.log10(1 + Math.max(0, memory.stability)) / Math.log10(1 + 365);
      return Math.min(1, Math.max(0, scaled));
    }
  }
}

/** Presentation familiarity for review-arcade enemy speed (never feeds back
 * into scheduling). */
export function wordFamiliarity(progress: Pick<WordProgress, "card">): number {
  return cardFamiliarity(progress.card);
}

/** A word is brand new when its card has never been reviewed. */
export function isUnseenWord(progress: Pick<WordProgress, "card">): boolean {
  return progress.card.reps === 0;
}
