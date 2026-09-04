import HanziWriter, { type Point } from "hanzi-writer";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
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

type PendingDemoPointer = {
  pointerId: number;
  points: Point[];
  ended: boolean;
  started: boolean;
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
  // A demo's opening pointer gesture begins before React can switch the writer
  // to quiz mode. Keep that gesture and feed it into the quiz once ready so
  // the first mouse/pen stroke or finger swipe is not discarded.
  const pendingDemoPointerRef = useRef<PendingDemoPointer | null>(null);
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
        if (canceled) return;

        // Hanzi Writer listens for mouse/touch start itself, but that event has
        // already happened when it caused a demo-to-quiz transition. Replay
        // the captured Pointer Events into the newly active quiz instead.
        const pending = pendingDemoPointerRef.current;
        if (pending && !pending.started && writer._quiz && pending.points[0]) {
          pending.started = true;
          void writer._quiz.startUserStroke(pending.points[0]);
          for (const point of pending.points.slice(1)) {
            void writer._quiz.continueUserStroke(point);
          }
          if (pending.ended) {
            writer._quiz.endUserStroke();
            pendingDemoPointerRef.current = null;
          }
        }
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

  const pointFromPointer = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const bounds = (hostRef.current ?? event.currentTarget).getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  const demoPlaying = mode.kind !== "writing";
  const engageProps = demoPlaying ? {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": mode.kind === "demo-loop"
      ? `${label}. Stroke-order preview playing. Press Enter or tap the square to start writing.`
      : `${label}. Stroke-order preview playing. Press Enter or draw on the square to start writing.`,
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      pendingDemoPointerRef.current = {
        pointerId: event.pointerId,
        points: [pointFromPointer(event)],
        ended: false,
        started: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is only an optimization; normal in-bounds pointer
        // events still preserve the stroke on older implementations.
      }
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

  const continuePendingDemoPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingDemoPointerRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromPointer(event);
    if (pending.started) {
      void writerRef.current?._quiz?.continueUserStroke(point);
    } else {
      pending.points.push(point);
    }
  };
  const endPendingDemoPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pending = pendingDemoPointerRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (pending.started) {
      writerRef.current?._quiz?.endUserStroke();
      pendingDemoPointerRef.current = null;
    } else {
      pending.ended = true;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released capture for a canceled pointer.
    }
  };
  // Once a Pointer Event owns the handoff, suppress its compatibility
  // mouse/touch events before Hanzi Writer's native target listeners see
  // them; otherwise the same opening stroke could be started twice.
  const suppressCompatibilityEvent = (event: ReactMouseEvent | ReactTouchEvent) => {
    if (!pendingDemoPointerRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return <div
    ref={gridRef}
    className={`writing-grid ${demoPlaying ? "is-demo" : ""}`}
    {...engageProps}
    onPointerMove={continuePendingDemoPointer}
    onPointerUp={endPendingDemoPointer}
    onPointerCancel={endPendingDemoPointer}
    onMouseDownCapture={suppressCompatibilityEvent}
    onMouseMoveCapture={suppressCompatibilityEvent}
    onTouchStartCapture={suppressCompatibilityEvent}
    onTouchMoveCapture={suppressCompatibilityEvent}
    data-writing-mode={mode.kind}
  >
    <div className="writing-grid-surface" aria-hidden="true">
      <div className="writing-grid-writer" ref={hostRef} />
    </div>
    {mode.kind === "demo-loop" && <span className="writing-grid-prompt" aria-hidden="true">TAP TO BEGIN</span>}
  </div>;
}
