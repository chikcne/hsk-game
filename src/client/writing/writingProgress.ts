/** Pure state machine for one Writing Screen card.
 *
 * A word is written one character at a time. The clock starts when writing
 * begins: at demo engagement for new cards, or at the first quiz stroke
 * (correct or mistaken) for later cards, so the first character's writing
 * time is counted. On a new card, every character gets its own demo before
 * its quiz; time spent watching those demos is excluded. The clock stops
 * when the last writable character completes. Every action is
 * idempotent where StrictMode double-dispatch or duplicated writer callbacks
 * can occur: `complete-unit` is guarded by the active index.
 *
 * Finishing a character without writing it has two distinct causes that stay
 * distinct in the state: `skipped` is the player's explicit choice via the
 * accessible finish control, while `missing` is automatic because the
 * character has no stroke data. Non-Han characters in a phrase (should not
 * occur in current decks) are marked done at creation so they render in the
 * progress row but never become the active writing target. */

export type WritingUnitStatus = "pending" | "writing" | "done" | "skipped" | "missing";
/** How the active unit stopped being the writing target. */
export type WritingUnitOutcome = "written" | "skipped" | "missing";
export type WritingPhase = "demo" | "writing" | "complete";

export type WordWritingState = {
  wordKey: string;
  units: string[];
  statuses: WritingUnitStatus[];
  /** Index of the unit being written; -1 once the word is complete. */
  activeIndex: number;
  phase: WritingPhase;
  /** New cards preview every writable character, not only the first one. */
  demoEachCharacter: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** Start of an inter-character demo after writing has begun. The initial
   * demo needs no timestamp because the writing clock has not started. */
  demoStartedAtMs: number | null;
  /** Time spent in completed inter-character demos, excluded from elapsed
   * writing time. */
  demoElapsedMs: number;
  /** Characters the player finished via the accessible finish control. */
  skippedCount: number;
  /** Characters auto-finished because their stroke data was absent. */
  missingCount: number;
  totalMisses: number;
};

export type WritingAction =
  | { type: "begin-writing"; nowMs: number }
  | { type: "complete-unit"; index: number; outcome: WritingUnitOutcome; nowMs: number }
  | { type: "record-miss"; count?: number }
  | { type: "reset"; wordKey: string; newCard: boolean };

const HAN_CHARACTER = /^\p{Script=Han}$/u;

export function createWordWritingState(wordKey: string, options: { newCard: boolean }): WordWritingState {
  const units = [...wordKey];
  const statuses: WritingUnitStatus[] = units.map((unit) => (HAN_CHARACTER.test(unit) ? "pending" : "done"));
  const firstActive = statuses.indexOf("pending");
  const writable = firstActive !== -1;
  return {
    wordKey,
    units,
    statuses,
    activeIndex: writable ? firstActive : -1,
    phase: writable ? (options.newCard ? "demo" : "writing") : "complete",
    demoEachCharacter: options.newCard,
    startedAtMs: writable ? null : 0,
    completedAtMs: writable ? null : 0,
    demoStartedAtMs: null,
    demoElapsedMs: 0,
    skippedCount: 0,
    missingCount: 0,
    totalMisses: 0,
  };
}

export function writingReducer(state: WordWritingState, action: WritingAction): WordWritingState {
  switch (action.type) {
    case "begin-writing": {
      if (state.phase === "complete") return state;
      if (state.phase === "writing" && state.startedAtMs !== null) return state;
      const resumedDemoMs = state.demoStartedAtMs === null
        ? 0
        : Math.max(0, action.nowMs - state.demoStartedAtMs);
      return {
        ...state,
        phase: "writing",
        // Engaging later character demos resumes the same word-level clock.
        startedAtMs: state.startedAtMs ?? action.nowMs,
        demoStartedAtMs: null,
        demoElapsedMs: state.demoElapsedMs + resumedDemoMs,
      };
    }
    case "complete-unit": {
      if (state.phase === "complete" || action.index !== state.activeIndex) return state;
      const statuses = state.statuses.slice();
      statuses[action.index] = action.outcome === "written" ? "done" : action.outcome;
      const activeIndex = statuses.indexOf("pending");
      const complete = activeIndex === -1;
      const nextPhase: WritingPhase = complete ? "complete" : state.demoEachCharacter ? "demo" : "writing";
      const interruptedDemoMs = state.demoStartedAtMs === null
        ? 0
        : Math.max(0, action.nowMs - state.demoStartedAtMs);
      return {
        ...state,
        statuses,
        activeIndex,
        phase: nextPhase,
        startedAtMs: state.startedAtMs ?? action.nowMs,
        completedAtMs: complete ? action.nowMs : null,
        demoStartedAtMs: nextPhase === "demo" ? action.nowMs : null,
        demoElapsedMs: state.demoElapsedMs + interruptedDemoMs,
        skippedCount: state.skippedCount + (action.outcome === "skipped" ? 1 : 0),
        missingCount: state.missingCount + (action.outcome === "missing" ? 1 : 0),
      };
    }
    case "record-miss":
      return { ...state, totalMisses: state.totalMisses + Math.max(0, action.count ?? 1) };
    case "reset":
      return createWordWritingState(action.wordKey, { newCard: action.newCard });
  }
}

export function activeCharacter(state: WordWritingState): string | null {
  return state.activeIndex === -1 ? null : state.units[state.activeIndex] ?? null;
}

/** Indexes of units that require actual writing (Han characters). */
export function writableIndexes(state: WordWritingState): number[] {
  const indexes: number[] = [];
  state.statuses.forEach((status, index) => {
    if (status !== "done" || (state.units[index] !== undefined && HAN_CHARACTER.test(state.units[index]!))) indexes.push(index);
  });
  return indexes;
}

/** Ordinal of the active unit among writable units, e.g. "2 of 3". */
export function activeWritableOrdinal(state: WordWritingState): number {
  const indexes = writableIndexes(state);
  const position = state.activeIndex === -1 ? indexes.length : indexes.indexOf(state.activeIndex) + 1;
  return Math.max(1, position);
}

export function writableUnitCount(state: WordWritingState): number {
  return writableIndexes(state).length;
}

export function completedUnitCount(state: WordWritingState): number {
  return state.statuses.reduce((total, status) => total + (status === "done" || status === "skipped" || status === "missing" ? 1 : 0), 0);
}

/** Milliseconds spent writing. Null before the clock starts; while writing it
 * is measured against `nowMs`, and once complete it is frozen. */
export function elapsedWritingMs(state: WordWritingState, nowMs: number): number | null {
  if (state.startedAtMs === null) return null;
  const end = state.phase === "complete" ? state.completedAtMs ?? nowMs : nowMs;
  const activeDemoMs = state.demoStartedAtMs === null
    ? 0
    : Math.max(0, end - state.demoStartedAtMs);
  return Math.max(0, end - state.startedAtMs - state.demoElapsedMs - activeDemoMs);
}

export function formatElapsedSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Stable React key for ONE PRESENTATION of a word. The Learn/Relearn
 * screens pass a generation counter that advances on every card serve —
 * including a re-serve of the SAME word after Again/Hard/Good — so the
 * WritingCard remounts with a fresh writing state instead of staying stuck
 * in its previous completed phase. */
export function presentationKey(serving: number, wordId: string): string {
  return `${Math.max(0, Math.floor(serving))}:${wordId}`;
}
