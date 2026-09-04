import HanziWriter from "hanzi-writer";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { StrokeCharacterData } from "../data/strokeData";

/** Palette-matched writer colors; keep in sync with the :root tokens in
 * src/client/styles/main.css (ghost / ink / cinnabar). */
const OUTLINE_COLOR = "#b4a37e";
const INK_COLOR = "#221a11";
const HINT_COLOR = "#c03a1e";

const PADDING_RATIO = 0.06;
/** Forgiving grading: above 1 is more lenient than hanzi-writer's default. */
const QUIZ_LENIENCY = 1.2;
const SHOW_HINT_AFTER_MISSES = 2;
const MARK_STROKE_CORRECT_AFTER_MISSES = 5;
/** Reduced-motion "demo": the finished glyph is held briefly without animating. */
const STATIC_DEMO_HOLD_MS = 1600;

export type GridMode = { kind: "demo-loop" } | { kind: "demo-once" } | { kind: "writing" };

export type GridStrokeEvent = {
  strokeNum: number;
  totalStrokes: number;
  mistakesOnStroke: number;
  totalMistakes: number;
  isBackwards: boolean;
};

/** Raw hanzi-writer quiz callback data (hanzi-writer 3.7.3 semantics).
 * `strokesRemaining` already discounts the finished stroke only when it was
 * correct: on a mistake the rejected stroke still counts as remaining. */
type WriterStrokeData = {
  strokeNum: number;
  strokesRemaining: number;
  mistakesOnStroke: number;
  totalMistakes: number;
  isBackwards: boolean;
};

/** Normalizes writer callback data. `isCorrect` must reflect which callback
 * the data came from, otherwise `totalStrokes` is off by one on mistakes. */
export function toGridStrokeEvent(strokeData: WriterStrokeData, isCorrect: boolean): GridStrokeEvent {
  return {
    strokeNum: strokeData.strokeNum,
    totalStrokes: strokeData.strokeNum + strokeData.strokesRemaining + (isCorrect ? 1 : 0),
    mistakesOnStroke: strokeData.mistakesOnStroke,
    totalMistakes: strokeData.totalMistakes,
    isBackwards: strokeData.isBackwards,
  };
}

type GridCallbacks = {
  onEngage?: () => void;
  onCorrectStroke?: (event: GridStrokeEvent) => void;
  onMistake?: (event: GridStrokeEvent) => void;
  onCharacterComplete?: (summary: { totalMistakes: number }) => void;
  onDemoFinished?: () => void;
};

type Props = GridCallbacks & {
  character: string;
  data: StrokeCharacterData | undefined;
  mode: GridMode;
  reducedMotion: boolean;
  /** Human description of the surface, used in accessible names. */
  label: string;
};

const reportedMissing = new Set<string>();

function reportMissing(character: string, reason: unknown) {
  const key = `${character}:${String(reason)}`;
  if (reportedMissing.has(key)) return;
  reportedMissing.add(key);
  console.error(`[writing-grid] Missing vector for ${character}.`, reason);
}

/** One hanzi-writer instance per mounted grid. The parent remounts the grid
 * for every character of the word (via key), so unmounting here is a hard
 * lifecycle boundary exactly like StrokeOrderCharacter: no delayed writer
 * callback can touch a host that has been torn down. The grey outline is
 * always shown and persists through demo and quiz. */
export function WritingGrid({ character, data, mode, reducedMotion, label, onEngage, onCorrectStroke, onMistake, onCharacterComplete, onDemoFinished }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  const callbacksRef = useRef<GridCallbacks>({});
  callbacksRef.current = { onEngage, onCorrectStroke, onMistake, onCharacterComplete, onDemoFinished };

  // When a demo hands over to the quiz (engaging a new card, or Show Demo
  // finishing), put keyboard focus back on the writing square so pointer and
  // keyboard users keep a sensible focus anchor. tabIndex={-1} keeps it out
  // of the tab order; the div is only focused programmatically.
  const prevModeKindRef = useRef<GridMode["kind"]>(mode.kind);
  useEffect(() => {
    const previous = prevModeKindRef.current;
    prevModeKindRef.current = mode.kind;
    if (previous !== "writing" && mode.kind === "writing") {
      gridRef.current?.focus({ preventScroll: true });
    }
  }, [mode.kind]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || failed) return;
    let disposed = false;
    setReady(false);
    const initialSize = Math.max(1, Math.round(host.getBoundingClientRect().width || 320));
    const writer = new HanziWriter(host, {
      width: initialSize,
      height: initialSize,
      padding: Math.max(2, Math.round(initialSize * PADDING_RATIO)),
      renderer: "svg",
      showOutline: true,
      showCharacter: false,
      outlineColor: OUTLINE_COLOR,
      strokeColor: INK_COLOR,
      drawingColor: INK_COLOR,
      highlightColor: HINT_COLOR,
      strokeAnimationSpeed: 1,
      strokeFadeDuration: 0,
      delayBetweenStrokes: 160,
      delayBetweenLoops: 900,
      drawingFadeDuration: 240,
      drawingWidth: 7,
      charDataLoader: (requested, _onLoad, onError) => {
        if (!data || requested !== character) {
          onError(new Error(`Unexpected character request ${requested}`));
          return;
        }
        return data;
      },
      onLoadCharDataError: (error) => {
        if (disposed) return;
        reportMissing(character, error ?? "Hanzi Writer rejected local data");
        setFailed(true);
      },
    });
    writerRef.current = writer;
    void writer.setCharacter(character)
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        reportMissing(character, error);
        setFailed(true);
      });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const size = Math.max(1, Math.round(entries[0]?.contentRect.width ?? initialSize));
      writer.updateDimensions({ width: size, height: size, padding: Math.max(2, Math.round(size * PADDING_RATIO)) });
    });
    observer?.observe(host);
    return () => {
      disposed = true;
      observer?.disconnect();
      writer.cancelQuiz();
      writer._renderState?.cancelAll();
      writer._hanziWriterRenderer?.destroy();
      if (writerRef.current === writer) writerRef.current = null;
      host.replaceChildren();
    };
  }, [character, data, failed]);

  // Mode switching (watching demo <-> quizzing) always stops whatever the
  // writer was doing first, then starts the new activity on a clean state.
  useEffect(() => {
    const writer = writerRef.current;
    if (!writer || !ready || failed) return;
    let canceled = false;
    const run = async () => {
      try {
      writer.cancelQuiz();
      writer._renderState?.cancelAll();
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      if (mode.kind === "writing") {
        await writer.hideCharacter({ duration: 0 });
        if (canceled) return;
        await writer.quiz({
          leniency: QUIZ_LENIENCY,
          showHintAfterMisses: SHOW_HINT_AFTER_MISSES,
          markStrokeCorrectAfterMisses: MARK_STROKE_CORRECT_AFTER_MISSES,
          acceptBackwardsStrokes: false,
          highlightOnComplete: false,
          onCorrectStroke: (strokeData) => {
            if (!canceled) callbacksRef.current.onCorrectStroke?.(toGridStrokeEvent(strokeData, true));
          },
          onMistake: (strokeData) => {
            if (!canceled) callbacksRef.current.onMistake?.(toGridStrokeEvent(strokeData, false));
          },
          onComplete: (summary) => {
            if (!canceled) callbacksRef.current.onCharacterComplete?.(summary);
          },
        });
      } else if (mode.kind === "demo-loop") {
        if (reducedMotion) {
          await writer.showCharacter({ duration: 0 });
          return;
        }
        await writer.hideCharacter({ duration: 0 });
        if (canceled) return;
        // Indefinite stroke-order demo until the surface is engaged.
        await writer.loopCharacterAnimation();
      } else {
        if (reducedMotion) {
          await writer.showCharacter({ duration: 0 });
          if (canceled) return;
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            if (!canceled) callbacksRef.current.onDemoFinished?.();
          }, STATIC_DEMO_HOLD_MS);
          return;
        }
        await writer.hideCharacter({ duration: 0 });
        if (canceled) return;
        await writer.animateCharacter({
          onComplete: () => {
            if (!canceled) callbacksRef.current.onDemoFinished?.();
          },
        });
      }
      } catch (error: unknown) {
        if (!canceled) {
          reportMissing(character, error);
          setFailed(true);
        }
      }
    };
    void run();
    return () => {
      canceled = true;
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    };
  }, [ready, failed, mode.kind, reducedMotion]);

  if (failed || !data) {
    return <div
      className="writing-grid writing-grid-missing"
      role="img"
      aria-label={`${label} — stroke data unavailable. Use Finish without writing to continue.`}
      data-writing-mode="missing"
    >
      <span className="writing-grid-missing-glyph" aria-hidden="true">{character}</span>
    </div>;
  }

  const engageable = mode.kind === "demo-loop";
  const engageProps = engageable ? {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `${label}. Stroke-order preview playing. Press Enter or tap the square to start writing.`,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      callbacksRef.current.onEngage?.();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        callbacksRef.current.onEngage?.();
      }
    },
  } : {
    role: "img" as const,
    tabIndex: -1,
    "aria-label": `${label}. Writing square. Draw with a mouse, pen, or finger. If you cannot write, use the finish button below.`,
  };

  return <div
    ref={gridRef}
    className={`writing-grid ${engageable ? "is-demo" : ""}`}
    {...engageProps}
    data-writing-mode={engageable ? "demo-loop" : mode.kind}
  >
    <div className="writing-grid-surface" aria-hidden="true">
      <div className="writing-grid-writer" ref={hostRef} />
    </div>
    {engageable && <span className="writing-grid-prompt" aria-hidden="true">TAP TO BEGIN</span>}
  </div>;
}
