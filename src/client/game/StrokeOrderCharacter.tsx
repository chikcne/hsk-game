import HanziWriter from "hanzi-writer";
import { memo, useEffect, useRef, useState } from "react";
import { STROKE_DRAW_MS, STROKE_GAP_MS, type StrokeCharacterData } from "../data/strokeData";

export type StrokeInk = "ink" | "target" | "solved";

const INK_COLORS: Record<StrokeInk, string> = {
  ink: "#221a11",
  target: "#c03a1e",
  solved: "#8f8163",
};
const reportedMissing = new Set<string>();

function reportFallback(character: string, reason: unknown) {
  const key = `${character}:${String(reason)}`;
  if (reportedMissing.has(key)) return;
  reportedMissing.add(key);
  console.error(`[stroke-renderer] Missing vector for ${character}.`, reason);
}

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
    let delayFrame: number | null = null;
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
        reportFallback(character, error ?? "Hanzi Writer rejected local data");
        setFailed(true);
      },
    });
    writerRef.current = writer;
    const waitForSequenceTurn = () => new Promise<void>((resolve) => {
      let remaining = Math.max(0, startDelayMs);
      let previous = performance.now();
      const tick = (now: number) => {
        if (disposed) return;
        const elapsed = Math.min(100, now - previous);
        previous = now;
        if (!pausedRef.current) remaining -= elapsed;
        if (remaining <= 0) resolve();
        else delayFrame = window.requestAnimationFrame(tick);
      };
      if (remaining === 0) resolve();
      else delayFrame = window.requestAnimationFrame(tick);
    });
    void writer.setCharacter(character).then(async () => {
      if (disposed) {
        writer._renderState?.cancelAll();
        writer._hanziWriterRenderer?.destroy();
        return;
      }
      await waitForSequenceTurn();
      if (disposed) return;
      void writer.animateCharacter().catch((error) => {
        if (!disposed) {
          reportFallback(character, error);
          setFailed(true);
        }
      });
      if (pausedRef.current) void writer.pauseAnimation();
    }).catch((error) => {
      if (!disposed) {
        reportFallback(character, error);
        setFailed(true);
      }
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const size = Math.max(1, Math.round(entries[0]?.contentRect.width ?? initialSize));
      writer.updateDimensions({ width: size, height: size, padding: Math.max(1, size * 0.035) });
    });
    observer?.observe(host);
    return () => {
      disposed = true;
      if (delayFrame !== null) window.cancelAnimationFrame(delayFrame);
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
    void (paused ? writer.pauseAnimation() : writer.resumeAnimation());
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
    if (!props.data) reportFallback(props.character, "character is absent from the loaded bundle");
  }, [props.character, props.data]);

  if (!props.data) return <span className="stroke-character-missing" aria-hidden="true" />;
  return props.animate
    ? <AnimatedStrokeOrderCharacter {...props} data={props.data} />
    : <StaticStrokeOrderCharacter character={props.character} data={props.data} />;
}

export const StrokeOrderCharacter = memo(StrokeOrderCharacterComponent);
