import { describe, expect, it } from "vitest";
import type { ComponentMemory } from "../../src/shared/schemas";
import {
  cardDueAtMs, cardFamiliarity, cardRetrievability, createCardMemory, hasBeenSeen,
  isCardAcquired, isCardDue, reviewCardMemory, wordFamiliarity,
} from "../../src/domain/memory";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;

function memory(patch: Partial<ComponentMemory>): ComponentMemory {
  return { ...createCardMemory(), state: "review", reps: 3, stability: 3, difficulty: 5, elapsedDays: 1, scheduledDays: 3, lastReview: new Date(NOW_MS - 4 * DAY_MS).toISOString(), due: new Date(NOW_MS - 1000).toISOString(), ...patch };
}

describe("single-card FSRS ratings", () => {
  it("again lands in a ~1 minute learning step; hard and good in later steps", () => {
    const fresh = createCardMemory();
    const again = reviewCardMemory(fresh, "again", NOW);
    expect(again.state).toBe("learning");
    expect(Date.parse(again.due)).toBe(NOW_MS + 60_000);
    expect(again.reps).toBe(1);
    expect(again.lapses).toBe(0); // first exposure is a learning step, not a lapse

    const hard = reviewCardMemory(fresh, "hard", NOW);
    expect(hard.state).toBe("learning");
    expect(Date.parse(hard.due)).toBe(NOW_MS + 6 * 60_000);

    const good = reviewCardMemory(fresh, "good", NOW);
    expect(good.state).toBe("learning");
    expect(Date.parse(good.due)).toBe(NOW_MS + 10 * 60_000);
  });

  it("easy graduates a new card straight into review with multi-day stability", () => {
    const easy = reviewCardMemory(createCardMemory(), "easy", NOW);
    expect(easy.state).toBe("review");
    expect(easy.scheduledDays).toBeGreaterThanOrEqual(1);
    expect(easy.stability).toBeGreaterThan(1);
    expect(easy.lastReview).toBe(NOW);
  });

  it("passes from learning graduate into review; again from review lapses into relearning", () => {
    const learning = reviewCardMemory(createCardMemory(), "good", NOW);
    const graduated = reviewCardMemory(learning, "good", new Date(NOW_MS + 11 * 60_000));
    expect(graduated.state).toBe("review");
    expect(graduated.scheduledDays).toBeGreaterThanOrEqual(1);

    const lapsed = reviewCardMemory(graduated, "again", new Date(Date.parse(graduated.due) + DAY_MS));
    expect(lapsed.state).toBe("relearning");
    expect(lapsed.lapses).toBe(1);

    const repaired = reviewCardMemory(lapsed, "good", new Date(Date.parse(lapsed.due) + 60_000));
    expect(repaired.state).toBe("review");
    expect(repaired.lapses).toBe(1);
  });

  it("is a pure function: the input card is untouched", () => {
    const card = createCardMemory();
    reviewCardMemory(card, "good", NOW);
    expect(card.reps).toBe(0);
    expect(card.state).toBe("new");
    expect(card.lastReview).toBeNull();
  });

  it("estimates retrievability: zero for new cards, decaying for review cards", () => {
    expect(cardRetrievability(createCardMemory(), NOW)).toBe(0);
    const fresh = memory({ lastReview: new Date(NOW_MS - DAY_MS).toISOString() });
    const old = memory({ lastReview: new Date(NOW_MS - 30 * DAY_MS).toISOString() });
    expect(cardRetrievability(fresh, NOW)).toBeGreaterThan(cardRetrievability(old, NOW));
  });
});

describe("acquisition and due-ness predicates", () => {
  it("treats review and relearning as acquired, learning/new as not", () => {
    expect(isCardAcquired(memory({ state: "review" }))).toBe(true);
    expect(isCardAcquired(memory({ state: "relearning" }))).toBe(true);
    expect(isCardAcquired(memory({ state: "learning" }))).toBe(false);
    expect(isCardAcquired(createCardMemory())).toBe(false);
  });

  it("marks never-reviewed cards as due and seen cards by their due date", () => {
    const fresh = createCardMemory();
    expect(isCardDue(fresh, new Date(NOW))).toBe(true);
    expect(hasBeenSeen(fresh)).toBe(false);
    const reviewed = memory({ due: new Date(NOW_MS + DAY_MS).toISOString() });
    expect(isCardDue(reviewed, new Date(NOW))).toBe(false);
    expect(isCardDue(reviewed, new Date(NOW_MS + 2 * DAY_MS))).toBe(true);
    expect(hasBeenSeen(reviewed)).toBe(true);
    expect(cardDueAtMs(reviewed)).toBe(NOW_MS + DAY_MS);
  });
});

describe("derived familiarity for arcade presentation", () => {
  it("grows from new over learning to review stability, capped at one", () => {
    const fresh = createCardMemory();
    expect(cardFamiliarity(fresh)).toBe(0);
    const learning = cardFamiliarity(memory({ state: "learning", reps: 1 }));
    expect(learning).toBeGreaterThan(0);
    const reviewOneWeek = cardFamiliarity(memory({ stability: 7, reps: 2 }));
    const reviewOneYear = cardFamiliarity(memory({ stability: 365, reps: 5 }));
    expect(reviewOneWeek).toBeGreaterThan(learning);
    expect(reviewOneYear).toBeGreaterThan(reviewOneWeek);
    expect(reviewOneYear).toBeLessThanOrEqual(1);
    expect(wordFamiliarity({ card: memory({ stability: 400 }) })).toBe(reviewOneYear);
    expect(wordFamiliarity({ card: memory({}) })).toBeLessThanOrEqual(1);
  });
});

describe("clock-skew clamp", () => {
  it("clamps a backwards-moving wall clock to the card's last review instead of corrupting the schedule", () => {
    const reviewAt = new Date(NOW_MS);
    const card = reviewCardMemory(createCardMemory(), "good", reviewAt);
    expect(card.state).toBe("learning");
    expect(card.lastReview).toBe(reviewAt.toISOString());

    // The wall clock jumps behind lastReview (NTP correction, timezone bug…):
    // the rating must behave exactly as if applied AT lastReview — not throw,
    // not trap the UI, and not compute negative elapsed time.
    const skewed = new Date(NOW_MS - 86_400_000);
    const atSkew = reviewCardMemory(card, "good", skewed);
    const atLastReview = reviewCardMemory(card, "good", reviewAt);
    expect(atSkew).toEqual(atLastReview);
    expect(Date.parse(atSkew.due)).toBeGreaterThan(NOW_MS); // scheduled forward
    expect(atSkew.lastReview).toBe(reviewAt.toISOString());

    // A normal forward rating is untouched by the clamp.
    const forward = reviewCardMemory(card, "good", new Date(NOW_MS + 11 * 60_000));
    expect(Date.parse(forward.due)).toBeGreaterThan(Date.parse(atSkew.due));
  });
});
