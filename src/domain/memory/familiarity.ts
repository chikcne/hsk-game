import type { ComponentMemory, WordProgress } from "../../shared/schemas";

/** Per-component familiarity in 0..1. Short-term (re)learning states sit low;
 * review-stage familiarity grows logarithmically with stability up to one year. */
export function componentFamiliarity(memory: ComponentMemory): number {
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

/** Battle-facing familiarity for the whole word: average of both components. */
export function wordFamiliarity(progress: Pick<WordProgress, "pinyin" | "meaning">): number {
  return (componentFamiliarity(progress.pinyin) + componentFamiliarity(progress.meaning)) / 2;
}

/** A word is brand new when no component has ever been reviewed. */
export function isUnseenWord(progress: Pick<WordProgress, "pinyin" | "meaning">): boolean {
  return progress.pinyin.reps === 0 && progress.meaning.reps === 0;
}
