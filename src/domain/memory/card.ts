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

/** A fresh, never-reviewed card: due immediately (epoch), state New. */
export function createCardMemory(): ComponentMemory {
  return toCardMemory(createEmptyCard(new Date(0)));
}

export function toCardMemory(card: Card): ComponentMemory {
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

export function fromCardMemory(memory: ComponentMemory): Card {
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

/** Applies one explicit Learn self-rating to a card and returns its next
 * memory state. Pure: the input card is never mutated.
 *
 * Clock-skew guard: FSRS derives elapsed time from `lastReview`, so a wall
 * clock that moved backwards between ratings would produce negative elapsed
 * days and corrupt stability. `now` is clamped to the card's last review —
 * the rating applies at that instant instead of trapping the UI or writing
 * a regressive schedule. */
export function reviewCardMemory(memory: ComponentMemory, rating: MemoryRating, now: string | number | Date): ComponentMemory {
  let date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid timestamp");
  const lastReviewMs = memory.lastReview === null ? null : Date.parse(memory.lastReview);
  if (lastReviewMs !== null && Number.isFinite(lastReviewMs) && date.getTime() < lastReviewMs) {
    date = new Date(lastReviewMs);
  }
  const { card } = scheduler.next(fromCardMemory(memory), date, RATING_TO_FSRS[rating]);
  return toCardMemory(card);
}

/** Estimated recall probability right now (0..1). New cards have no history
 * and deliberately score 0 so they never outrank known material. */
export function cardRetrievability(memory: ComponentMemory, now: string | number | Date): number {
  if (memory.state === "new") return 0;
  return scheduler.get_retrievability(fromCardMemory(memory), new Date(now), false);
}
