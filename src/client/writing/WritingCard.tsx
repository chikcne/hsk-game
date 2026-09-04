import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { StrokeDataMap } from "../data/strokeData";
import { HanziText } from "../game/HanziText";
import { useCardAudio } from "./useCardAudio";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { WritingGrid, type GridMode, type GridStrokeEvent } from "./WritingGrid";
import {
  activeCharacter,
  activeWritableOrdinal,
  createWordWritingState,
  elapsedWritingMs,
  formatElapsedSeconds,
  writableUnitCount,
  writingReducer,
  type WordWritingState,
} from "./writingProgress";
import {
  audioFailureFeedback,
  correctStrokeFeedback,
  demoPromptFeedback,
  missingDataFeedback,
  mistakeFeedback,
  nextStrokeFeedback,
  type WritingFeedback,
} from "./writingFeedback";
import "../styles/writing.css";

export type WritingCardWord = {
  id: string;
  displayHanzi: string;
  displayPinyin: string;
  meaning: string;
};

export type WordWritingResult = {
  /** Milliseconds spent writing. The clock starts at demo engagement for new
   * cards, or at the first quiz stroke — correct or mistaken — for later
   * cards, so first-character time is counted; stroke-order demo watching is
   * excluded. */
  elapsedMs: number;
  /** Characters the player finished with the accessible finish control. */
  skippedCharacters: number;
  /** Characters auto-finished because their stroke data was absent; kept
   * separate from `skippedCharacters` because the player did not choose it. */
  missingDataCharacters: number;
  /** Rejected stroke attempts across the whole word. */
  totalMisses: number;
};

type Props = {
  word: WritingCardWord;
  /** Fully loaded stroke data: every Han character in `word.displayHanzi`
   * must already be present in the map (an awaited `loadStrokeBundle(s)`
   * result — the grid never fetches lazily). A character missing from the
   * map is finished automatically and reported via
   * `missingDataCharacters`, but the word cannot be written properly. */
  strokeData: StrokeDataMap;
  /** First-ever presentation of the word: every character gets an
   * indefinitely replaying stroke-order demo until its writing surface is
   * engaged. */
  isNewCard: boolean;
  /** Combine the app's settings value with the system preference; the OS
   * preference is honored directly even when this is omitted. */
  reducedMotion?: boolean;
  /** Resolved local audio URL for the word; "" disables playback. */
  audioSource?: string;
  audioVolume?: number;
  /** Rating UI deliberately does not live here: this callback is where the
   * Learn agent attaches its controls. Fires exactly once per word. */
  onWordComplete: (result: WordWritingResult) => void;
};

type StrokeProgress = {
  strokeNum: number;
  totalStrokes: number;
  mistakesOnStroke: number;
  isBackwards: boolean;
  lastEvent: "correct" | "mistake" | null;
};

const INITIAL_STROKE_PROGRESS: StrokeProgress = { strokeNum: -1, totalStrokes: 0, mistakesOnStroke: 0, isBackwards: false, lastEvent: null };

const reportedMissingData = new Set<string>();

function slotText(unit: string, status: WordWritingState["statuses"][number], active: boolean): string {
  if (status === "done") return `${unit} written`;
  if (status === "skipped") return `${unit} finished without writing`;
  if (status === "missing") return `${unit} finished automatically — no stroke data`;
  if (active) return `${unit} writing now`;
  return `${unit} waiting`;
}

/** Reusable Writing Screen card: pinyin and meaning above a single large
 * tian-zi square, one active character at a time, completed characters
 * filling a bottom-center progress row. Integration is deliberately isolated
 * from App.tsx, useBattle, saves, and scheduling. */
export function WritingCard({ word, strokeData, isNewCard, reducedMotion: reducedMotionProp = false, audioSource = "", audioVolume = 1, onWordComplete }: Props) {
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = reducedMotionProp || systemReducedMotion;
  const [state, dispatch] = useReducer(
    writingReducer,
    word.displayHanzi,
    (wordKey) => createWordWritingState(wordKey, { newCard: isNewCard }),
  );
  const wordIdRef = useRef(word.id);
  useEffect(() => {
    if (wordIdRef.current === word.id) return;
    wordIdRef.current = word.id;
    dispatch({ type: "reset", wordKey: word.displayHanzi, newCard: isNewCard });
  }, [word.id, word.displayHanzi, isNewCard]);

  // The grid mode follows the phase: on new cards each active character gets
  // a looping demo before its quiz. demo-once is the only transient override.
  const [gridMode, setGridMode] = useState<GridMode>(() => ({ kind: state.phase === "demo" ? "demo-loop" : "writing" }));
  useEffect(() => {
    setGridMode({ kind: state.phase === "demo" ? "demo-loop" : "writing" });
  }, [state.phase, state.wordKey]);

  const character = activeCharacter(state);
  const characterData = character === null ? undefined : strokeData.get(character);
  const totalStrokes = characterData ? characterData.strokes.length : 0;
  const activeOrdinal = activeWritableOrdinal(state);
  const writableTotal = writableUnitCount(state);

  const [strokeProgress, setStrokeProgress] = useState<StrokeProgress>(INITIAL_STROKE_PROGRESS);
  // Reset on character AND word changes: a reset keyed on the character alone
  // leaks feedback when the next word starts with the same character.
  useEffect(() => {
    setStrokeProgress(INITIAL_STROKE_PROGRESS);
  }, [state.wordKey, state.activeIndex]);

  const handleEngage = useCallback(() => {
    dispatch({ type: "begin-writing", nowMs: performance.now() });
  }, []);
  // The clock starts at the first quiz stroke — correct or mistaken — so the
  // time spent on the first character is counted. `begin-writing` is a no-op
  // once the clock runs (demo engagement, an earlier stroke, or a skip).
  const handleCorrectStroke = useCallback((event: GridStrokeEvent) => {
    dispatch({ type: "begin-writing", nowMs: performance.now() });
    setStrokeProgress({ strokeNum: event.strokeNum, totalStrokes: event.totalStrokes, mistakesOnStroke: 0, isBackwards: false, lastEvent: "correct" });
  }, []);
  const handleMistake = useCallback((event: GridStrokeEvent) => {
    dispatch({ type: "begin-writing", nowMs: performance.now() });
    dispatch({ type: "record-miss" });
    setStrokeProgress({ strokeNum: event.strokeNum, totalStrokes: event.totalStrokes, mistakesOnStroke: event.mistakesOnStroke, isBackwards: event.isBackwards, lastEvent: "mistake" });
  }, []);
  // The writer callback carries no index, so resolve the active unit at call
  // time through a ref; the reducer still guards against stale dispatches.
  const activeIndexRef = useRef(state.activeIndex);
  activeIndexRef.current = state.activeIndex;
  const handleCharacterComplete = useCallback(() => {
    if (activeIndexRef.current === -1) return;
    dispatch({ type: "complete-unit", index: activeIndexRef.current, outcome: "written", nowMs: performance.now() });
  }, []);

  const handleDemoFinished = useCallback(() => {
    setGridMode({ kind: "writing" });
  }, []);

  // Missing stroke data must never trap a player: such a character is
  // finished automatically, and recorded as `missing` — distinct from a
  // player-initiated skip. The index guard makes StrictMode's double effect
  // invocation a no-op.
  useEffect(() => {
    if (state.phase === "complete" || character === undefined || characterData) return;
    if (character === null) return;
    const key = `${state.wordKey}:${state.activeIndex}`;
    if (!reportedMissingData.has(key)) {
      reportedMissingData.add(key);
      console.error(`[writing-card] No stroke data for ${character}; finishing it automatically.`);
    }
    dispatch({ type: "complete-unit", index: state.activeIndex, outcome: "missing", nowMs: performance.now() });
  }, [character, characterData, state.activeIndex, state.phase, state.wordKey]);

  // Canceling the skip confirm (KEEP WRITING or Escape) returns focus to the
  // opener so keyboard users do not fall back to <body>.
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const skipButtonRef = useRef<HTMLButtonElement>(null);
  const restoreSkipFocusRef = useRef(false);
  const cancelSkip = useCallback(() => {
    restoreSkipFocusRef.current = true;
    setConfirmingSkip(false);
  }, []);
  useEffect(() => {
    if (confirmingSkip || !restoreSkipFocusRef.current) return;
    restoreSkipFocusRef.current = false;
    skipButtonRef.current?.focus();
  }, [confirmingSkip]);
  useEffect(() => {
    if (!confirmingSkip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingSkip, cancelSkip]);
  const handleSkip = useCallback(() => {
    setConfirmingSkip(false);
    dispatch({ type: "begin-writing", nowMs: performance.now() });
    dispatch({ type: "complete-unit", index: activeIndexRef.current, outcome: "skipped", nowMs: performance.now() });
  }, []);

  // Exactly-once completion per word, exposed to the parent with the
  // measured writing time. Rating controls belong to the caller.
  const completedResultSentRef = useRef(false);
  useEffect(() => {
    if (state.phase !== "complete") {
      completedResultSentRef.current = false;
      return;
    }
    if (completedResultSentRef.current) return;
    completedResultSentRef.current = true;
    onWordComplete({
      elapsedMs: elapsedWritingMs(state, state.completedAtMs ?? 0) ?? 0,
      skippedCharacters: state.skippedCount,
      missingDataCharacters: state.missingCount,
      totalMisses: state.totalMisses,
    });
  }, [state, onWordComplete]);

  const audio = useCardAudio(audioSource, audioVolume);

  let feedback: WritingFeedback;
  if (state.phase === "complete") {
    const elapsed = elapsedWritingMs(state, 0) ?? 0;
    feedback = { tone: "good", message: `Word complete in ${formatElapsedSeconds(elapsed)}.` };
  } else if (state.phase === "demo") {
    feedback = demoPromptFeedback();
  } else if (character !== null && !characterData) {
    feedback = missingDataFeedback(character);
  } else if (strokeProgress.lastEvent === "mistake") {
    feedback = mistakeFeedback({ strokeNum: strokeProgress.strokeNum, totalStrokes, mistakesOnStroke: strokeProgress.mistakesOnStroke, isBackwards: strokeProgress.isBackwards });
  } else if (strokeProgress.lastEvent === "correct") {
    feedback = correctStrokeFeedback({ strokesRemaining: Math.max(0, totalStrokes - strokeProgress.strokeNum - 1) });
  } else {
    feedback = nextStrokeFeedback({ strokeNum: 0, totalStrokes });
  }
  const announcement = state.phase === "complete"
    ? `${word.displayHanzi} complete in ${formatElapsedSeconds(elapsedWritingMs(state, 0) ?? 0)}.`
    : character === null
      ? "Loading character."
      : `Character ${activeOrdinal} of ${writableTotal}. ${feedback.message}`;

  return <section className={`writing-card ${reducedMotion ? "reduce-motion" : ""}`} aria-label={`Write ${word.displayHanzi} (${word.displayPinyin})`}>
    <header className="writing-card-head">
      <div className="writing-card-word">
        {audioSource && <button type="button" className={`writing-audio ${audio.error ? "is-error" : ""}`} onClick={audio.replay} aria-label={audio.error ? "Replay word audio — the last attempt failed" : "Replay word audio"}>♪</button>}
        {audio.error && <span className="writing-sr" role="status">{audioFailureFeedback().message}</span>}
        <p className="writing-pinyin" lang="zh-Hans">{word.displayPinyin}</p>
      </div>
      <p className="writing-meaning"><HanziText text={word.meaning} data={strokeData} /></p>
      {state.phase !== "complete" && <p className="writing-count">{`Character ${activeOrdinal} of ${writableTotal}`}</p>}
    </header>

    {character !== null
      ? <WritingGrid
        key={`${state.wordKey}:${state.activeIndex}`}
        character={character}
        data={characterData}
        mode={gridMode}
        reducedMotion={reducedMotion}
        label={`Writing ${character}`}
        onEngage={handleEngage}
        onCorrectStroke={handleCorrectStroke}
        onMistake={handleMistake}
        onCharacterComplete={handleCharacterComplete}
        onDemoFinished={handleDemoFinished}
      />
      : <div className="writing-grid writing-grid-done" role="img" aria-label={`${word.displayHanzi} complete`}>
        <div className="writing-grid-surface is-complete" aria-hidden="true">
          <HanziText text={word.displayHanzi} data={strokeData} accessible={false} />
        </div>
      </div>}

    <p className={`writing-status is-${feedback.tone}`} role="status">{announcement}</p>

    <div className="writing-controls">
      {state.phase === "writing" && gridMode.kind === "writing" && (
        <button type="button" className="writing-secondary" onClick={() => setGridMode({ kind: "demo-once" })}>SHOW DEMO</button>
      )}
      {state.phase !== "complete" && (confirmingSkip ? (
        <span className="writing-skip-confirm" role="group" aria-label="Confirm finishing without writing">
          <span>Finish without writing?</span>
          <button type="button" className="writing-danger" autoFocus onClick={handleSkip}>FINISH CHARACTER</button>
          <button type="button" onClick={cancelSkip}>KEEP WRITING</button>
        </span>
      ) : (
        <button type="button" ref={skipButtonRef} className="writing-secondary" onClick={() => setConfirmingSkip(true)}>FINISH WITHOUT WRITING</button>
      ))}
    </div>

    <ol className="writing-row" aria-label="Phrase progress">
      {state.units.map((unit, index) => {
        const status = state.statuses[index]!;
        const active = index === state.activeIndex;
        const finished = status === "done" || status === "skipped" || status === "missing";
        return <li key={index} className={`writing-slot is-${status}${active ? " is-active" : ""}`} aria-current={active ? "step" : undefined}>
          {finished
            ? <HanziText text={unit} data={strokeData} accessible={false} />
            : <span className="writing-slot-blank" aria-hidden="true" />}
          <span className="writing-sr">{slotText(unit, status, active)}</span>
        </li>;
      })}
    </ol>
  </section>;
}
