import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Effect, Exit } from "effect";
import { DECK_IDS, type DeckId } from "../../shared/constants";
import type { RuntimeDeck, RuntimeWord, SaveFile, WordProgress } from "../../shared/schemas";
import { wordAudioSource, WordAudioPlayer } from "../audio/wordAudio";
import type { StrokeDataMap } from "../data/strokeData";
import { HanziText } from "../game/HanziText";

export type GlossaryDeck = { deckId: DeckId; deck: RuntimeDeck };

export type GlossaryEntry = {
  key: string;
  deckId: DeckId;
  word: RuntimeWord;
  progress: WordProgress | null;
  revealed: boolean;
  encounterNumber: number | null;
  mastery: number;
};

function masteryPercent(progress: WordProgress | null): number {
  if (!progress) return 0;
  switch (progress.card.state) {
    case "new": return Math.min(20, progress.learnReviews * 5);
    case "learning": return Math.min(55, 25 + progress.learnReviews * 6);
    case "relearning": return 60;
    case "review": return 100;
  }
}

function masteryLabel(progress: WordProgress): string {
  switch (progress.card.state) {
    case "new": return "Newly encountered";
    case "learning": return "Building memory";
    case "relearning": return "Rebuilding memory";
    case "review": return "Mastered";
  }
}

/** Builds the table with encountered words first in global introduction
 * order, followed by every still-concealed curriculum tile. Ties are stable:
 * first-review time, acquisition order, grade, then authored curriculum. */
export function buildGlossaryEntries(save: SaveFile, decks: readonly GlossaryDeck[]): GlossaryEntry[] {
  const acquisitionOrder = new Map(
    [...save.acquiredWords].reverse().map((key, index) => [key, index]),
  );
  const sortable = decks.flatMap(({ deckId, deck }) => {
    const curriculumIndex = new Map(
      deck.curriculum.lessons.flatMap((lesson) => lesson.wordIds).map((id, index) => [id, index]),
    );
    const level = save.levels[deckId];
    return deck.words.map((word, fallbackIndex) => {
      const progress = level?.words[word.id] ?? null;
      const introducedOrdinal = progress?.introducedAtOrdinal ?? null;
      const key = `${deckId}:${word.id}`;
      const seenMs = progress?.lastSeenAt ? Date.parse(progress.lastSeenAt) : Number.POSITIVE_INFINITY;
      return {
        entry: {
          key,
          deckId,
          word,
          progress,
          revealed: introducedOrdinal !== null,
          encounterNumber: null,
          mastery: masteryPercent(progress),
        } satisfies GlossaryEntry,
        introducedOrdinal: introducedOrdinal ?? Number.POSITIVE_INFINITY,
        seenMs: Number.isFinite(seenMs) ? seenMs : Number.POSITIVE_INFINITY,
        acquiredIndex: acquisitionOrder.get(key) ?? Number.POSITIVE_INFINITY,
        deckIndex: DECK_IDS.indexOf(deckId),
        curriculumIndex: curriculumIndex.get(word.id) ?? fallbackIndex,
      };
    });
  });

  sortable.sort((a, b) =>
    Number(b.entry.revealed) - Number(a.entry.revealed)
    || a.introducedOrdinal - b.introducedOrdinal
    || a.seenMs - b.seenMs
    || a.acquiredIndex - b.acquiredIndex
    || a.deckIndex - b.deckIndex
    || a.curriculumIndex - b.curriculumIndex,
  );

  let encounterNumber = 0;
  return sortable.map(({ entry }) => entry.revealed
    ? { ...entry, encounterNumber: ++encounterNumber }
    : entry);
}

function tileFaceColor(mastery: number): string {
  const mix = Math.max(0, Math.min(100, mastery)) / 100;
  const channel = (start: number, end: number) => Math.round(start + (end - start) * mix);
  return `rgb(${channel(255, 218)} ${channel(253, 178)} ${channel(244, 72)})`;
}

/** One-pass derived view model: key lookup for the drawer plus the summary
 * totals, so selection changes never rescan the full catalogue. */
export function buildGlossaryIndex(entries: readonly GlossaryEntry[]): {
  byKey: ReadonlyMap<string, GlossaryEntry>;
  encountered: number;
  mastered: number;
} {
  const byKey = new Map<string, GlossaryEntry>();
  let encountered = 0;
  let mastered = 0;
  for (const entry of entries) {
    byKey.set(entry.key, entry);
    if (entry.revealed) encountered += 1;
    if (entry.progress?.card.state === "review") mastered += 1;
  }
  return { byKey, encountered, mastered };
}

type GlossaryTileProps = {
  entry: GlossaryEntry;
  strokeData: StrokeDataMap;
  selected: boolean;
  onPlay: (entry: GlossaryEntry) => void;
};

/** Memoized per-tile subtree. Safe because entry objects come from the
 * parent's entries memo, strokeData is a stable loaded bundle, and onPlay is a
 * stable callback: drawer open/close, audio errors, and selection flips only
 * rerender tiles whose props changed. */
const GlossaryTile = memo(function GlossaryTile({ entry, strokeData, selected, onPlay }: GlossaryTileProps) {
  if (!entry.revealed) return <div className="mahjong-tile tile-back" aria-hidden="true" />;
  return <button
    className={`mahjong-tile tile-face ${selected ? "is-selected" : ""}`}
    style={{ "--tile-face": tileFaceColor(entry.mastery) } as CSSProperties}
    onClick={() => onPlay(entry)}
    aria-label={`${entry.word.displayHanzi}, ${entry.word.displayPinyin}, ${masteryLabel(entry.progress!)}`}
  >
    <small>{String(entry.encounterNumber).padStart(3, "0")}</small>
    <strong data-word-length={[...entry.word.displayHanzi].length}>
      <HanziText text={entry.word.displayHanzi} data={strokeData} accessible={false} />
    </strong>
    <span>HSK {entry.deckId.at(-1)}</span>
  </button>;
});

export function GlossaryScreen({ save, decks, strokeData, onExit }: {
  save: SaveFile;
  decks: readonly GlossaryDeck[];
  strokeData: StrokeDataMap;
  onExit: () => void;
}) {
  const entries = useMemo(() => buildGlossaryEntries(save, decks), [save, decks]);
  const index = useMemo(() => buildGlossaryIndex(entries), [entries]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [audioError, setAudioError] = useState(false);
  const playerRef = useRef<WordAudioPlayer | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const selected = selectedKey ? index.byKey.get(selectedKey) ?? null : null;

  useEffect(() => {
    const player = new WordAudioPlayer();
    playerRef.current = player;
    return () => {
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!selected) return;
    closeButtonRef.current?.focus({ preventScroll: true });
  }, [selected?.key]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (selectedKey) setSelectedKey(null);
      else onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit, selectedKey]);

  const playEntry = useCallback((entry: GlossaryEntry) => {
    const player = playerRef.current;
    const source = wordAudioSource(entry.deckId, entry.word);
    setSelectedKey(entry.key);
    setAudioError(false);
    if (!player || !source) return;
    Effect.runFork(player.playEffect(source, save.settings.masterVolume).pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        if (Exit.isFailure(exit) && playerRef.current === player) setAudioError(true);
      })),
    ));
  }, [save.settings.masterVolume]);

  return <main className={`glossary-screen paper ${save.settings.reducedMotion ? "reduce-motion" : ""}`}>
    <section className="mahjong-table" aria-label={`Glossary with ${index.encountered} encountered words and ${entries.length - index.encountered} concealed words`}>
      <div className="glossary-overview">
        <button className="glossary-back" onClick={onExit} aria-label="Return to glossary grade selection"><span aria-hidden="true">←</span> GRADES</button>
        <div className="glossary-summary">
          <dl className="glossary-totals">
            <div><dt>ENCOUNTERED</dt><dd>{index.encountered}</dd></div>
            <div><dt>MASTERED</dt><dd>{index.mastered}</dd></div>
          </dl>
          <div className="glossary-legend" aria-hidden="true">
            <span><i className="legend-dot legend-new" /> NEW</span>
            <span><i className="legend-dot legend-growing" /> LEARNING</span>
            <span><i className="legend-dot legend-mastered" /> MASTERED</span>
            <span><i className="legend-dot legend-hidden" /> CONCEALED</span>
          </div>
        </div>
      </div>
      <ol className="mahjong-grid">
        {entries.map((entry) => <li key={entry.key}>
          <GlossaryTile entry={entry} strokeData={strokeData} selected={selectedKey === entry.key} onPlay={playEntry} />
        </li>)}
      </ol>
    </section>

    {selected && <>
      <button className="glossary-scrim" onClick={() => setSelectedKey(null)} aria-label="Close word details" tabIndex={-1} />
      <aside className="glossary-drawer" aria-label={`Details for ${selected.word.displayHanzi}`}>
        <button ref={closeButtonRef} className="drawer-close" onClick={() => setSelectedKey(null)} aria-label="Close word details">×</button>
        <p className="drawer-eyebrow">ENCOUNTER {String(selected.encounterNumber).padStart(3, "0")} · HSK {selected.deckId.at(-1)}</p>
        <div className="drawer-word"><HanziText text={selected.word.displayHanzi} data={strokeData} /></div>
        <button className="drawer-audio" onClick={() => playEntry(selected)} aria-label={`Play pronunciation for ${selected.word.displayHanzi}`}>
          <span aria-hidden="true">◖)))</span> PLAY WORD
        </button>
        {audioError && <p className="drawer-audio-error" role="alert">Audio could not be played.</p>}
        <section><small>PINYIN</small><p className="drawer-pinyin">{selected.word.displayPinyin}</p></section>
        <section><small>DEFINITION</small><p className="drawer-definition">{selected.word.meaning}</p></section>
        <section className="drawer-mastery">
          <small>MASTERY</small>
          <div><strong>{masteryLabel(selected.progress!)}</strong><b>{selected.mastery}%</b></div>
          <span><i style={{ width: `${selected.mastery}%` }} /></span>
          <p>{selected.progress!.learnReviews} learning {selected.progress!.learnReviews === 1 ? "review" : "reviews"}</p>
        </section>
      </aside>
    </>}
  </main>;
}
