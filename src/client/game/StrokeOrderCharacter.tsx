import HanziWriter from "hanzi-writer";
import { memo, useEffect, useRef, useState } from "react";
import { STROKE_DRAW_MS, STROKE_GAP_MS, type StrokeCharacterData } from "../data/strokeData";

export type StrokeInk = "ink" | "target" | "solved";

const INK_COLORS: Record<StrokeInk, string> = {
  ink: "#211d18",
  target: "#a94332",
  solved: "#8d8a82",
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
  paused: boolean;
  ink: StrokeInk;
};

/** Imperative Hanzi Writer wrapper. The instance is tied only to a mounted
 * enemy/character slot, so movement rerenders and target changes never replay
 * its stroke sequence. */
function StrokeOrderCharacterComponent({ character, data, animate, startDelayMs, paused, ink }: Props) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const writerRef = useRef<HanziWriter | null>(null);
  const animateOnMountRef = useRef(animate);
  const animateOnMount = animateOnMountRef.current;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!data) reportFallback(character, "character is absent from the loaded bundle");
  }, [character, data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !data || failed) return;
    let disposed = false;
    let delayFrame: number | null = null;
    const initialSize = Math.max(1, Math.round(host.getBoundingClientRect().width || 48));
    const writer = new HanziWriter(host, {
      width: initialSize,
      height: initialSize,
      padding: Math.max(1, initialSize * 0.035),
      renderer: "svg",
      // Pre-spawn writing begins on a blank sheet: do not reveal the gray
      // completed-glyph guide underneath the animated ink.
      showOutline: false,
      showCharacter: !animateOnMount,
      strokeColor: INK_COLORS[ink],
      strokeAnimationDuration: STROKE_DRAW_MS,
      strokeFadeDuration: 0,
      delayBetweenStrokes: STROKE_GAP_MS,
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
      if (!animateOnMount) return;
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
  }, [animateOnMount, character, data, failed, startDelayMs]);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer || !animateOnMount) return;
    void (paused ? writer.pauseAnimation() : writer.resumeAnimation());
  }, [animateOnMount, paused]);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer || animate || !animateOnMount) return;
    writer._renderState?.cancelAll();
    void writer.showCharacter({ duration: 0 });
    void writer.hideOutline({ duration: 0 });
  }, [animate, animateOnMount]);

  useEffect(() => {
    const writer = writerRef.current;
    if (!writer) return;
    void writer.updateColor("strokeColor", INK_COLORS[ink], { duration: animate ? 90 : 0 });
  }, [ink]);

  if (!data || failed) return <span className="stroke-character-missing" aria-hidden="true" />;
  return <span ref={hostRef} className="stroke-character" data-character={character} />;
}

export const StrokeOrderCharacter = memo(StrokeOrderCharacterComponent);
