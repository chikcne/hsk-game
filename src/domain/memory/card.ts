import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from "ts-fsrs";
import type { ComponentMemory } from "../../shared/schemas";
import type { MemoryRating } from "./types";

/**
 * Single shared FSRS scheduler. Fuzz is disabled so scheduling stays
 * deterministic (tests, replays, and save validation); personal parameter
 * optimization is deliberately deferred until a few hundred real reviews
 * exist, exactly as the SRS research plan prescribes.
 */
export const FSRS_PARAMETERS = generatorParameters({ enable_fuzz: false });
const scheduler = fsrs(FSRS_PARAMETERS);

const MEMORY_STATE_TO_FSRS: Record<ComponentMemory["state"], State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const FSRS_STATE_TO_MEMORY: Record<State, ComponentMemory["state"]> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const RATING_TO_FSRS: Record<MemoryRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export function createComponentMemory(): ComponentMemory {
  return toComponentMemory(createEmptyCard(new Date(0)));
}

export function toComponentMemory(card: Card): ComponentMemory {
  return {
    state: FSRS_STATE_TO_MEMORY[card.state],
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review?.toISOString() ?? null,
  };
}

export function fromComponentMemory(memory: ComponentMemory): Card {
  return {
    due: new Date(memory.due),
    stability: memory.stability,
    difficulty: memory.difficulty,
    elapsed_days: memory.elapsedDays,
    scheduled_days: memory.scheduledDays,
    learning_steps: memory.learningSteps,
    reps: memory.reps,
    lapses: memory.lapses,
    state: MEMORY_STATE_TO_FSRS[memory.state],
    ...(memory.lastReview === null ? {} : { last_review: new Date(memory.lastReview) }),
  };
}

/** Applies one graded recall to one component and returns the next memory state. */
export function reviewComponentMemory(memory: ComponentMemory, rating: MemoryRating, now: string | number | Date): ComponentMemory {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  const { card } = scheduler.next(fromComponentMemory(memory), date, RATING_TO_FSRS[rating]);
  return toComponentMemory(card);
}

/** Estimated recall probability right now (0..1). New cards have no history
 * and deliberately score 0 so they never outrank known material. */
export function componentRetrievability(memory: ComponentMemory, now: string | number | Date): number {
  if (memory.state === "new") return 0;
  return scheduler.get_retrievability(fromComponentMemory(memory), new Date(now), false);
}
