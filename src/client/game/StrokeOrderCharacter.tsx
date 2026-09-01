import HanziWriter from "hanzi-writer";
import { memo, useEffect, useRef, useState } from "react";
import type { StrokeCharacterData } from "../data/strokeData";

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
  console.error(`[stroke-renderer] Static UKai fallback for ${character}.`, reason);
}

type Props = {
  character: string;
  data: StrokeCharacterData | undefined;
  animate: boolean;
  paused: boolean;
  ink: StrokeInk;
};

/** Imperative Hanzi Writer wrapper. The instance is tied only to a mounted
 * enemy/character slot, so movement rerenders and target changes never replay
 * its stroke sequence. */
function StrokeOrderCharacterComponent({ character, data, animate, paused, ink }: Props) {
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
    const initialSize = Math.max(1, Math.round(host.getBoundingClientRect().width || 48));
    const writer = new HanziWriter(host, {
      width: initialSize,
      height: initialSize,
      padding: Math.max(1, initialSize * 0.035),
      renderer: "svg",
      showOutline: animateOnMount,
      showCharacter: !animateOnMount,
      outlineColor: "#c4baa5",
      outlineWidth: 1.35,
      strokeColor: INK_COLORS[ink],
      strokeAnimationSpeed: 4,
      strokeFadeDuration: 80,
      delayBetweenStrokes: 20,
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
    void writer.setCharacter(character).then(() => {
      if (disposed) {
        writer._renderState?.cancelAll();
        writer._hanziWriterRenderer?.destroy();
        return;
      }
      if (!animateOnMount) return;
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
      observer?.disconnect();
      writer._renderState?.cancelAll();
      writer._hanziWriterRenderer?.destroy();
      if (writerRef.current === writer) writerRef.current = null;
      host.replaceChildren();
    };
  }, [animateOnMount, character, data, failed]);

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

  if (!data || failed) return <span className="stroke-character-fallback" lang="zh-Hans">{character}</span>;
  return <span ref={hostRef} className="stroke-character" data-character={character} />;
}

export const StrokeOrderCharacter = memo(StrokeOrderCharacterComponent);
