import { REVIEW_REPAIR_DELAY_SPAWNS } from "../../shared/constants";

export type ReviewSpawnSource = "base" | "repair";

export type ReviewSpawnDecision =
  | { kind: "spawn"; wordKey: string; source: ReviewSpawnSource }
  | { kind: "wait" }
  | { kind: "complete" };

/** A missed word's open obligation. It stays open until one later encounter
 * of the word is fully correct (typed pinyin, correct meaning, no reveal). */
export type ReviewObligation = {
  wordKey: string;
  /** Base-plan cursor at the moment of the most recent miss; the repair
   * becomes due after `REVIEW_REPAIR_DELAY_SPAWNS` further base spawns have
   * been reserved (or immediately once the base plan is exhausted). */
  missedAtCursor: number;
  /** Misses recorded for this word during the session. */
  misses: number;
};

/** Pure, nonpersisted coordination state for one Review battle's spawn
 * stream. The runtime (useBattle) holds it in a ref; every transition is a
 * pure, immutable step so the retry semantics are deterministically
 * testable without a browser. */
export type ReviewSession = {
  /** The deterministic base plan in serving order. */
  plan: readonly string[];
  /** Base-plan spawns reserved so far (strictly in plan order). */
  cursor: number;
  /** Additive repair spawns served beyond the base plan. */
  repairsServed: number;
  /** Open repair obligations. Map insertion order keeps the OLDEST miss
   * first, so forced retries drain in first-missed order. */
  obligations: ReadonlyMap<string, ReviewObligation>;
};

export function createReviewSession(plan: readonly string[]): ReviewSession {
  return { plan, cursor: 0, repairsServed: 0, obligations: new Map() };
}

/**
 * Decides the next spawn, deterministically. Priority:
 *
 * 1. the OLDEST repair obligation that is due and whose word is not
 *    currently active or preparing (the same word never spawns
 *    concurrently). An obligation is due after
 *    `REVIEW_REPAIR_DELAY_SPAWNS` further base spawns have been reserved
 *    since its latest miss, or as soon as the base plan is exhausted —
 *    retries are additive beyond the plan target and forced, so endgame
 *    repairs cannot deadlock on a lagging counter;
 * 2. the next base-plan spawn (skipped only while that exact word is
 *    active — the active enemy resolves in finite time, so waiting is safe);
 * 3. `complete` when the base plan is fully consumed and no obligation
 *    remains. The caller still requires an empty battlefield (no active and
 *    no preparing enemy) before declaring the session over.
 */
export function decideReviewSpawn(session: ReviewSession, activeWordKeys: ReadonlySet<string>): ReviewSpawnDecision {
  const baseKey = session.cursor < session.plan.length ? session.plan[session.cursor]! : null;
  for (const [wordKey, obligation] of session.obligations) {
    const due = session.cursor >= session.plan.length
      || session.cursor - obligation.missedAtCursor >= REVIEW_REPAIR_DELAY_SPAWNS;
    if (due && !activeWordKeys.has(wordKey)) return { kind: "spawn", wordKey, source: "repair" };
  }
  if (baseKey !== null && !activeWordKeys.has(baseKey)) return { kind: "spawn", wordKey: baseKey, source: "base" };
  if (baseKey === null && session.obligations.size === 0) return { kind: "complete" };
  return { kind: "wait" };
}

/** Commits a decision: base spawns advance the cursor; repair spawns are
 * additive and consume nothing from the plan. */
export function reserveReviewSpawn(session: ReviewSession, decision: Extract<ReviewSpawnDecision, { kind: "spawn" }>): ReviewSession {
  if (decision.source === "base") return { ...session, cursor: session.cursor + 1 };
  return { ...session, repairsServed: session.repairsServed + 1 };
}

/** Records one resolved encounter. A clean, fully correct response clears
 * the word's obligation; any miss — wrong pinyin, wrong meaning, a landing,
 * or a pinyin autocomplete reveal even when the meaning is then correct —
 * creates it or requeues it (fresh delay, back of the oldest-first queue). */
export function applyReviewOutcome(session: ReviewSession, wordKey: string, cleanCorrect: boolean): { session: ReviewSession; cleared: boolean } {
  if (cleanCorrect) {
    if (!session.obligations.has(wordKey)) return { session, cleared: false };
    const obligations = new Map(session.obligations);
    obligations.delete(wordKey);
    return { session: { ...session, obligations }, cleared: true };
  }
  const obligations = new Map(session.obligations);
  const previous = obligations.get(wordKey);
  obligations.delete(wordKey);
  obligations.set(wordKey, { wordKey, missedAtCursor: session.cursor, misses: (previous?.misses ?? 0) + 1 });
  return { session: { ...session, obligations }, cleared: false };
}

/** True when nothing is left to do: every base spawn reserved AND resolved
 * (the caller's active set is empty), no preparing enemy, no obligation. */
export function isReviewSessionSettled(session: ReviewSession, activeWordKeys: ReadonlySet<string>): boolean {
  return session.cursor >= session.plan.length && session.obligations.size === 0 && activeWordKeys.size === 0;
}

/** Unresolved committed work for the round-progress bar: base spawns not
 * yet reserved, plus open repair obligations EXCLUDING those an in-flight
 * (active or preparing) enemy of the same word already serves — counting
 * both would double-book one spawn. Displayed as
 * `resolved / (resolved + pendingWork + inFlightCount)` this stays strictly
 * below 100% while a final-base miss has created a pending repair (no
 * 100%→regress flicker) and reaches exactly 100% only when the session
 * truly completes. */
export function pendingReviewWork(
  session: ReviewSession,
  planLength: number,
  inFlightWordKeys: ReadonlySet<string>,
): number {
  let coveredInFlight = 0;
  for (const key of inFlightWordKeys) if (session.obligations.has(key)) coveredInFlight += 1;
  return Math.max(0, planLength - session.cursor) + Math.max(0, session.obligations.size - coveredInFlight);
}
