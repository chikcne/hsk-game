import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DifficultySettings, RuntimeDeck, SaveFile } from "../../shared/schemas";
import { formatLearnInterval, previewLearnCard } from "../../domain/learn";
import { nextRelearnKey, type RelearnRatingApplication } from "../../domain/relearn";
import { reviewWordIdOf } from "../../domain/review";
import { wordAudioSource } from "../audio/wordAudio";
import type { StrokeDataMap } from "../data/strokeData";
import { HanziText } from "../game/HanziText";
import { formatElapsedSeconds, presentationKey } from "../writing/writingProgress";
import { WritingCard, type WordWritingResult } from "../writing/WritingCard";

const RATING_ORDER: Array<{ rating: "again" | "hard" | "good" | "easy"; label: string; hanzi: string; key: string }> = [
  { rating: "again", label: "AGAIN", hanzi: "忘记", key: "1" },
  { rating: "hard", label: "HARD", hanzi: "困难", key: "2" },
  { rating: "good", label: "GOOD", hanzi: "良好", key: "3" },
  { rating: "easy", label: "EASY", hanzi: "简单", key: "4" },
];

const statusLabel = (status: string) => status === "saved" ? "PROGRESS SAVED" : status === "saving" ? "SAVING PROGRESS" : status === "offline" ? "SAVED OFFLINE" : "SAVE ERROR";

type SessionEntry = {
  wordKey: string;
  rating: "again" | "hard" | "good" | "easy";
  elapsedMs: number;
  reacquired: boolean;
};

type Props = {
  save: SaveFile;
  /** Merged runtime deck built from exactly the session's word keys. */
  deck: RuntimeDeck;
  strokeData: StrokeDataMap;
  settings: DifficultySettings;
  saveStatus: "saved" | "saving" | "offline" | "error";
  /** Applies the rating to the member's INDEPENDENT card (pure domain step +
   * atomic save queue) and returns the application so the screen advances. */
  onRate: (wordKey: string, rating: "again" | "hard" | "good" | "easy") => RelearnRatingApplication | null;
  onExit: () => void;
  onSettings: () => void;
};

/** Re-Learn Mode: the one cross-grade active session, presented with the
 * same Learn/Writing UX — pinyin + meaning, looping demo on a member's first
 * presentation, elapsed writing time, four explicit ratings with live
 * interval previews, and earliest-due learn-ahead. Ratings advance the
 * member's INDEPENDENT card stored inside the session (never the main Learn
 * card); a member finishes the moment its card reaches FSRS review, moving
 * its key to the front of `acquired_words`. Progress saves after every
 * rating, so exiting preserves exact state. */
export function RelearnScreen({ save, deck, strokeData, settings, saveStatus, onRate, onExit, onSettings }: Props) {
  const session = save.relearnSession;
  const [currentKey, setCurrentKey] = useState<string | null>(() => {
    if (!session) return null;
    const next = nextRelearnKey(session, new Date());
    return next.status === "card" ? next.wordKey : null;
  });
  const [ratingPhase, setRatingPhase] = useState<WordWritingResult | null>(null);
  const [log, setLog] = useState<SessionEntry[]>([]);
  const [finished, setFinished] = useState(() => session === null || currentKey === null);
  const previewClock = useRef(new Date());
  // Advances on every presentation — including a re-serve of the SAME word
  // after Again/Hard/Good (the one-word session case) — so the WritingCard
  // remounts fresh instead of staying stuck in its completed phase.
  const [serving, setServing] = useState(0);
  // Synchronous lock against two rapid 1–4 presses / double clicks
  // double-rating one presentation; released on the next completion.
  const ratingLockRef = useRef(false);
  const firstRatingButtonRef = useRef<HTMLButtonElement>(null);

  const wordMap = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const currentWord = currentKey === null ? undefined : wordMap.get(currentKey);
  const currentCardState = session && currentKey !== null ? session.cards[currentKey] : undefined;
  const remaining = session ? session.wordKeys.length : 0;

  const handleWordComplete = useCallback((result: WordWritingResult) => {
    previewClock.current = new Date();
    ratingLockRef.current = false;
    setRatingPhase(result);
  }, []);

  // Move focus to the first rating button when the panel appears.
  useEffect(() => {
    if (!ratingPhase || finished) return;
    firstRatingButtonRef.current?.focus();
  }, [ratingPhase, finished]);

  const handleRate = useCallback((rating: "again" | "hard" | "good" | "easy") => {
    if (ratingLockRef.current) return; // already rated this presentation
    if (!session || !currentKey || !ratingPhase) return;
    ratingLockRef.current = true;
    const wordKey = currentKey;
    const applied = onRate(wordKey, rating);
    if (!applied) {
      ratingLockRef.current = false;
      return;
    }
    setLog((entries) => [...entries, {
      wordKey,
      rating,
      elapsedMs: ratingPhase.elapsedMs,
      reacquired: applied.reacquired,
    }]);
    setRatingPhase(null);
    const nextSession = applied.save.relearnSession;
    if (!nextSession || applied.sessionCompleted) {
      setFinished(true);
      setCurrentKey(null);
      return;
    }
    const next = nextRelearnKey(nextSession, new Date());
    if (next.status === "complete") {
      setFinished(true);
      setCurrentKey(null);
      return;
    }
    setServing((generation) => generation + 1);
    setCurrentKey(next.wordKey);
  }, [currentKey, onRate, ratingPhase, session]);

  // Keyboard: 1–4 choose the rating while the rating panel is open.
  useEffect(() => {
    if (!ratingPhase || finished) return;
    const listener = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (document.querySelector('[aria-modal="true"]')) return; // settings dialog owns the keys
      const choice = RATING_ORDER.find((item) => item.key === event.key);
      if (choice) { event.preventDefault(); handleRate(choice.rating); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [finished, handleRate, ratingPhase]);

  const ratingPreviews = useMemo(() => {
    if (!ratingPhase || !currentCardState) return null;
    return RATING_ORDER.map(({ rating }) => {
      const preview = previewLearnCard(currentCardState.card, rating, previewClock.current);
      return { rating, interval: formatLearnInterval(Date.parse(preview.due) - previewClock.current.getTime()) };
    });
  }, [currentCardState, ratingPhase]);

  if (finished || !session || !currentWord || !currentCardState) {
    return <RelearnSummary deck={deck} log={log} saveStatus={saveStatus} strokeData={strokeData} onExit={onExit} />;
  }

  // First presentation inside the relearn session: the independent card has
  // never been rated, so the looping stroke-order demo runs.
  const isFirstPresentation = currentCardState.card.reps === 0;

  return <main className={`paper learn-screen ${settings.reducedMotion ? "reduce-motion" : ""}`}>
    <header className="learn-hud">
      <div className="hud-level"><span className="seal">重</span><p><b>RE-LEARN</b><small>{remaining} TO GO</small></p></div>
      <span className={`save-state ${saveStatus}`}><i /> {statusLabel(saveStatus)}</span>
      <button className="settings-button" onClick={onSettings} aria-label="System settings">
        <img className="mooncake-icon" src="/images/mooncake-settings.png" alt="" />
      </button>
      <button className="learn-exit" onClick={onExit}>GRADES</button>
    </header>

    <div className="learn-stage">
      <WritingCard
        key={presentationKey(serving, currentWord.id)}
        word={{ id: currentWord.id, displayHanzi: currentWord.displayHanzi, displayPinyin: currentWord.displayPinyin, meaning: currentWord.meaning }}
        strokeData={strokeData}
        isNewCard={isFirstPresentation}
        reducedMotion={settings.reducedMotion}
        audioSource={wordAudioSource(reviewWordIdOf(currentWord.id).deckId, currentWord)}
        audioVolume={settings.masterVolume}
        onWordComplete={handleWordComplete}
      />

      {ratingPhase && <section className="learn-rating" aria-label="Rate your recall">
        <p className="learn-rating-head">
          Wrote <strong lang="zh-Hans"><HanziText text={currentWord.displayHanzi} data={strokeData} /></strong>
          {" "}in <b>{formatElapsedSeconds(ratingPhase.elapsedMs)}</b>
          {ratingPhase.totalMisses > 0 && <> · <span>{ratingPhase.totalMisses} {ratingPhase.totalMisses === 1 ? "stroke" : "strokes"} rejected</span></>}
        </p>
        <p className="learn-rating-prompt">HOW WELL DID YOU RECALL IT?</p>
        <div className="learn-rating-grid">
          {RATING_ORDER.map(({ rating, label, hanzi, key }, index) => (
            <button
              key={rating}
              ref={index === 0 ? firstRatingButtonRef : undefined}
              className={`learn-rating-button is-${rating}`}
              onClick={() => handleRate(rating)}
            >
              <span className="learn-rating-key">{key}</span>
              <b>{label}</b>
              <HanziText text={hanzi} data={strokeData} accessible={false} />
              <em>{ratingPreviews ? `${ratingPreviews[index]!.interval}` : "—"}</em>
            </button>
          ))}
        </div>
      </section>}
    </div>
  </main>;
}

function RelearnSummary({ deck, log, saveStatus, strokeData, onExit }: {
  deck: RuntimeDeck;
  log: SessionEntry[];
  saveStatus: string;
  strokeData: StrokeDataMap;
  onExit: () => void;
}) {
  const reacquired = log.filter((entry) => entry.reacquired);
  const counts = {
    again: log.filter((entry) => entry.rating === "again").length,
    hard: log.filter((entry) => entry.rating === "hard").length,
    good: log.filter((entry) => entry.rating === "good").length,
    easy: log.filter((entry) => entry.rating === "easy").length,
  };
  const totalWritingMs = log.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  return <main className="paper summary-screen">
    <header><h1>RE-LEARN COMPLETE</h1><p>{`SELECTED WORDS REPAIRED • SESSION CLEARED`}</p></header>
    <section className="stat-grid">
      <div><small>WORDS FINISHED</small><b className="mint">{reacquired.length}</b></div>
      <div><small>AGAIN / HARD</small><b className="red">{counts.again} / {counts.hard}</b></div>
      <div><small>GOOD / EASY</small><b className="amber">{counts.good} / {counts.easy}</b></div>
      <div><small>WRITING TIME</small><b className="cyan">{formatElapsedSeconds(totalWritingMs)}</b></div>
    </section>
    <section className="summary-details">
      <div className="mastery-report">
        <h2>BACK AT THE FRONT OF YOUR ACQUIRED WORDS <span>{reacquired.length}</span></h2>
        {reacquired.length === 0
          ? <p>No words finished this session.</p>
          : <><small>MOVED TO NEWEST IN ACQUIRED WORDS</small><div className="next-up">{reacquired.map((entry, index) => <span key={index}><HanziText text={deck.words.find((word) => word.id === entry.wordKey)?.displayHanzi ?? reviewWordIdOf(entry.wordKey).wordId} data={strokeData} /></span>)}</div></>}
      </div>
      <div className="save-report">
        <small>SAVE STATUS</small>
        <b className={saveStatus === "saved" ? "mint" : "red"}>{saveStatus === "saved" ? "✓ ALL PROGRESS SAVED" : "! PROGRESS CACHED LOCALLY"}</b>
      </div>
    </section>
    <footer><button className="primary" onClick={onExit}>RETURN TO GRADES</button></footer>
  </main>;
}
