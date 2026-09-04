import HanziWriter from "hanzi-writer";
import { Data, Effect } from "effect";
import { memo, useEffect, useRef, useState } from "react";
import { STROKE_DRAW_MS, STROKE_GAP_MS, type StrokeCharacterData } from "../data/strokeData";

export type StrokeInk = "ink" | "target" | "solved";

const INK_COLORS: Record<StrokeInk, string> = {
  ink: "#221a11",
  target: "#c03a1e",
  solved: "#8f8163",
};

/** A Hanzi Writer operation failed (rejected local data, animation error, or
 * a character missing from the loaded bundle). The glyph falls back to a
 * missing-vector box. */
export class HanziWriterError extends Data.TaggedError("HanziWriterError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

const toError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)));

const reportedMissing = new Set<string>();

function reportFallback(character: string, reason: HanziWriterError) {
  const key = `${character}:${reason.message}`;
  if (reportedMissing.has(key)) return;
  reportedMissing.add(key);
  console.error(`[stroke-renderer] Missing vector for ${character}.`, reason);
}

const setCharacter = (writer: HanziWriter, character: string): Effect.Effect<void, HanziWriterError, never> =>
  Effect.tryPromise({
    try: () => writer.setCharacter(character),
    catch: (cause) =>
      new HanziWriterError({ message: `Hanzi Writer rejected data for ${character}`, cause: toError(cause) }),
  });

const animateCharacter = (writer: HanziWriter): Effect.Effect<void, HanziWriterError, never> =>
  Effect.tryPromise({
    try: () => writer.animateCharacter(),
    catch: (cause) => new HanziWriterError({ message: "stroke animation failed", cause: toError(cause) }),
  });

const pauseAnimation = (writer: HanziWriter): Effect.Effect<void, HanziWriterError, never> =>
  Effect.tryPromise({
    try: () => writer.pauseAnimation(),
    catch: (cause) => new HanziWriterError({ message: "pausing animation failed", cause: toError(cause) }),
  });

const toggleAnimation = (writer: HanziWriter, paused: boolean): Effect.Effect<void, HanziWriterError, never> =>
  Effect.tryPromise({
    try: () => (paused ? writer.pauseAnimation() : writer.resumeAnimation()),
    catch: (cause) => new HanziWriterError({ message: "toggling animation failed", cause: toError(cause) }),
  });

/** Active (unpaused) time counted down on animation frames. Interruption
 * cancels the pending frame via the async canceler. */
const waitForSequenceTurn = (isPaused: () => boolean, budgetMs: number): Effect.Effect<void, never, never> =>
  Effect.async<void>((resume) => {
    let remaining = Math.max(0, budgetMs);
    let previous = performance.now();
    let frame: number | null = null;
    const tick = (now: number) => {
      const elapsed = Math.min(100, now - previous);
      previous = now;
      if (!isPaused()) remaining -= elapsed;
      if (remaining <= 0) resume(Effect.void);
      else frame = window.requestAnimationFrame(tick);
    };
    if (remaining === 0) resume(Effect.void);
    else frame = window.requestAnimationFrame(tick);
    return Effect.sync(() => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    });
  });

type Props = {
  character: string;
  data: StrokeCharacterData | undefined;
  animate: boolean;
  /** Active (unpaused) time to wait before this character starts writing. */
  startDelayMs: number;
  /** Write-cadence multiplier (1 = natural). Scales stroke draw/gap durations
   * and the sequence delay together, so the phrase finishes proportionally
   * faster — used to honor the empty-battlefield spawn budget. */
  writeSpeed: number;
  paused: boolean;
  ink: StrokeInk;
};

type AnimatedProps = Omit<Props, "animate"> & { data: StrokeCharacterData };

/** Hanzi Writer exists only during pre-spawn writing. Unmounting this component
 * at gameplay spawn is a hard lifecycle boundary: no delayed writer callback
 * can mutate or replay a live enemy's completed glyph. */
function AnimatedStrokeOrderCharacter({ character, data, startDelayMs, writeSpeed, paused, ink }: AnimatedProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || failed) return;
    let disposed = false;
    const initialSize = Math.max(1, Math.round(host.getBoundingClientRect().width || 48));
    const writer = new HanziWriter(host, {
      width: initialSize,
      height: initialSize,
      padding: Math.max(1, initialSize * 0.035),
      renderer: "svg",
      showOutline: false,
      showCharacter: false,
      strokeColor: INK_COLORS[ink],
      strokeAnimationDuration: STROKE_DRAW_MS / writeSpeed,
      strokeFadeDuration: 0,
      delayBetweenStrokes: STROKE_GAP_MS / writeSpeed,
      charDataLoader: (requested, _onLoad, onError) => {
        if (requested !== character) {
          onError(new Error(`Unexpected character request ${requested}`));
          return;
        }
        return data;
      },
      onLoadCharDataError: (error) => {
        if (disposed) return;
        reportFallback(character, new HanziWriterError({
          message: "Hanzi Writer rejected local data",
          cause: error instanceof Error ? error : undefined,
        }));
        setFailed(true);
      },
    });
    writerRef.current = writer;
    const onSequenceFailure = (error: HanziWriterError) =>
      Effect.sync(() => {
        if (disposed) return;
        reportFallback(character, error);
        setFailed(true);
      });
    // Load local data, wait for this character's turn in the phrase cadence,
    // then animate; a paused start arms the writer in place.
    const sequence = Effect.gen(function* () {
      yield* setCharacter(writer, character);
      yield* waitForSequenceTurn(() => pausedRef.current, startDelayMs);
      yield* Effect.fork(animateCharacter(writer).pipe(Effect.catchAll(onSequenceFailure)));
      if (pausedRef.current) yield* Effect.ignore(pauseAnimation(writer));
    });
    const fiber = Effect.runFork(Effect.catchAll(sequence, onSequenceFailure));

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const size = Math.max(1, Math.round(entries[0]?.contentRect.width ?? initialSize));
      writer.updateDimensions({ width: size, height: size, padding: Math.max(1, size * 0.035) });
    });
    observer?.observe(host);
    return () => {
      disposed = true;
      fiber.unsafeInterruptAsFork(fiber.id());
      observer?.disconnect();
      writer._renderState?.cancelAll();
      writer._hanziWriterRenderer?.destroy();
      if (writerRef.current === writer) writerRef.current = null;
      host.replaceChildren();
    };
  }, [character, data, failed, ink, startDelayMs, writeSpeed]);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer) return;
    Effect.runFork(Effect.ignore(toggleAnimation(writer, paused)));
  }, [paused]);

  if (failed) return <span className="stroke-character-missing" aria-hidden="true" />;
  return <span ref={hostRef} className="stroke-character" data-character={character} />;
}

/** Live and solved enemies are declarative SVG. They contain no animation
 * state, timers, or imperative renderer that could redraw them later. */
function StaticStrokeOrderCharacter({ character, data }: { character: string; data: StrokeCharacterData }) {
  return <span className="stroke-character" data-character={character}>
    <svg aria-hidden="true" focusable="false" viewBox="0 0 1024 1024">
      <g transform="translate(0 900) scale(1 -1)">
        {data.strokes.map((path, index) => <path d={path} fill="currentColor" key={index} />)}
      </g>
    </svg>
  </span>;
}

function StrokeOrderCharacterComponent(props: Props) {
  useEffect(() => {
    if (!props.data) {
      reportFallback(props.character, new HanziWriterError({ message: "character is absent from the loaded bundle" }));
    }
  }, [props.character, props.data]);

  if (!props.data) return <span className="stroke-character-missing" aria-hidden="true" />;
  return props.animate
    ? <AnimatedStrokeOrderCharacter {...props} data={props.data} />
    : <StaticStrokeOrderCharacter character={props.character} data={props.data} />;
}

export const StrokeOrderCharacter = memo(StrokeOrderCharacterComponent);
