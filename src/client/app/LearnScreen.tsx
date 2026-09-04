import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckId } from "../../shared/constants";
import type { DifficultySettings, RuntimeDeck, SaveFile } from "../../shared/schemas";
import {
  formatLearnInterval, nextLearnCardId, previewLearnCard, remainingLearnWordIds,
  type LearnRating, type LearnRatingApplication,
} from "../../domain/learn";
import { wordAudioSource } from "../audio/wordAudio";
import type { StrokeDataMap } from "../data/strokeData";
import { HanziText } from "../game/HanziText";
import { curriculumLessonNumber } from "../../domain/learning";
import { formatElapsedSeconds, presentationKey } from "../writing/writingProgress";
import { WritingCard, type WordWritingResult } from "../writing/WritingCard";

const RATING_ORDER: Array<{ rating: LearnRating; label: string; hanzi: string; key: string }> = [
  { rating: "again", label: "AGAIN", hanzi: "忘记", key: "1" },
  { rating: "hard", label: "HARD", hanzi: "困难", key: "2" },
  { rating: "good", label: "GOOD", hanzi: "良好", key: "3" },
  { rating: "easy", label: "EASY", hanzi: "简单", key: "4" },
];

const statusLabel = (status: string) => status === "saved" ? "PROGRESS SAVED" : status === "saving" ? "SAVING PROGRESS" : status === "offline" ? "SAVED OFFLINE" : "SAVE ERROR";

type SessionEntry = {
  wordId: string;
  rating: LearnRating;
  elapsedMs: number;
  newlyAcquired: boolean;
  completed: boolean;
};

type Props = {
  save: SaveFile;
  deck: RuntimeDeck;
  strokeData: StrokeDataMap;
  settings: DifficultySettings;
  saveStatus: "saved" | "saving" | "offline" | "error";
  /** Applies the rating to the save (pure domain step + atomic queue) and
   * returns the application result so the screen can advance exactly. */
  onRate: (deckId: DeckId, wordId: string, rating: LearnRating) => LearnRatingApplication | null;
  onExit: () => void;
  onAgain: () => void;
  onSettings: () => void;
};

/** Learn Mode: one card at a time. Guided writing first, then the writing
 * time plus four explicit self-ratings with computed next intervals; a word
 * leaves the session when its card reaches the FSRS review state, and the
 * session ends when every member has. */
export function LearnScreen({ save, deck, strokeData, settings, saveStatus, onRate, onExit, onAgain, onSettings }: Props) {
  const session = save.learnSessions[deck.id] ?? null;
  const level = save.levels[deck.id] ?? null;
  const [currentWordId, setCurrentWordId] = useState<string | null>(() => {
    if (!session || !level) return null;
    const next = nextLearnCardId(session, level, new Date());
    return next.status === "card" ? next.wordId : null;
  });
  const [ratingPhase, setRatingPhase] = useState<WordWritingResult | null>(null);
  const [log, setLog] = useState<SessionEntry[]>([]);
  const [finished, setFinished] = useState(() => session === null || currentWordId === null);
  const previewClock = useRef(new Date());
  // Advances on every card presentation — INCLUDING a re-serve of the same
  // word after Again/Hard/Good — so the WritingCard's React key changes and
  // the card remounts fresh instead of staying in its completed phase.
  const [serving, setServing] = useState(0);
  // Synchronous lock: two rapid 1–4 presses (or double clicks) must not
  // double-rate a presentation before the next one renders. Released when
  // the next presentation's card completes writing.
  const ratingLockRef = useRef(false);
  const firstRatingButtonRef = useRef<HTMLButtonElement>(null);

  const wordMap = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const currentWord = currentWordId === null ? undefined : wordMap.get(currentWordId);
  const currentProgress = currentWordId === null || !level ? undefined : level.words[currentWordId];
  const remaining = session && level ? remainingLearnWordIds(session, level).length : 0;

  const handleWordComplete = useCallback((result: WordWritingResult) => {
    previewClock.current = new Date();
    ratingLockRef.current = false;
    setRatingPhase(result);
  }, []);

  // Focus lands on the first rating button as the panel appears, so Enter
  // and Tab work without a pointer; the 1–4 shortcuts stay live.
  useEffect(() => {
    if (!ratingPhase || finished) return;
    firstRatingButtonRef.current?.focus();
  }, [ratingPhase, finished]);

  const handleRate = useCallback((rating: LearnRating) => {
    if (ratingLockRef.current) return; // already rated this presentation
    if (!session || !level || !currentWordId || !ratingPhase) return;
    ratingLockRef.current = true;
    const wordId = currentWordId;
    const applied = onRate(deck.id, wordId, rating);
    if (!applied) {
      ratingLockRef.current = false;
      return;
    }
    setLog((entries) => [...entries, {
      wordId,
      rating,
      elapsedMs: ratingPhase.elapsedMs,
      // The domain already dedupes against the prior acquired_words table.
      newlyAcquired: applied.newlyAcquired,
      completed: applied.wordCompleted,
    }]);
    setRatingPhase(null);
    const nextSession = applied.save.learnSessions[deck.id] ?? null;
    const nextLevel = applied.save.levels[deck.id]!;
    if (!nextSession || applied.sessionCompleted) {
      setFinished(true);
      setCurrentWordId(null);
      return;
    }
    const next = nextLearnCardId(nextSession, nextLevel, new Date());
    if (next.status === "complete") {
      setFinished(true);
      setCurrentWordId(null);
      return;
    }
    setServing((generation) => generation + 1);
    setCurrentWordId(next.wordId);
  }, [currentWordId, deck.id, level, onRate, ratingPhase, session]);

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
    if (!ratingPhase || !currentProgress) return null;
    return RATING_ORDER.map(({ rating }) => {
      const preview = previewLearnCard(currentProgress.card, rating, previewClock.current);
      return { rating, interval: formatLearnInterval(Date.parse(preview.due) - previewClock.current.getTime()) };
    });
  }, [currentProgress, ratingPhase]);

  if (finished || !session || !level || !currentWord || !currentProgress) {
    return <LearnSummary
      deck={deck} log={log} saveStatus={saveStatus} strokeData={strokeData}
      totalMembers={session?.wordIds.length ?? log.filter((entry) => entry.completed).length}
      onExit={onExit} onAgain={onAgain} />;
  }

  const isNewCard = currentProgress.card.reps === 0;

  return <main className={`paper learn-screen ${settings.reducedMotion ? "reduce-motion" : ""}`}>
    <header className="learn-hud">
      <div className="hud-level"><span className="seal">学</span><p><b>HSK {deck.id.at(-1)} · LEARN</b><small>{remaining} TO GO · LESSON {curriculumLessonNumber(level, settings.levelSize)}</small></p></div>
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
        isNewCard={isNewCard}
        reducedMotion={settings.reducedMotion}
        audioSource={wordAudioSource(deck.id, currentWord)}
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

function LearnSummary({ deck, log, saveStatus, strokeData, totalMembers, onExit, onAgain }: {
  deck: RuntimeDeck;
  log: SessionEntry[];
  saveStatus: string;
  strokeData: StrokeDataMap;
  totalMembers: number;
  onExit: () => void;
  onAgain: () => void;
}) {
  const completed = log.filter((entry) => entry.completed);
  const acquired = log.filter((entry) => entry.newlyAcquired);
  const counts = {
    again: log.filter((entry) => entry.rating === "again").length,
    hard: log.filter((entry) => entry.rating === "hard").length,
    good: log.filter((entry) => entry.rating === "good").length,
    easy: log.filter((entry) => entry.rating === "easy").length,
  };
  const totalWritingMs = log.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  return <main className="paper summary-screen">
    <header><h1>LEARN COMPLETE</h1><p>{`HSK ${deck.id.at(-1)} • SESSION FINISHED`}</p></header>
    <section className="stat-grid">
      <div><small>WORDS FINISHED</small><b className="mint">{completed.length}</b></div>
      <div><small>NEWLY ACQUIRED</small><b className="amber">+{acquired.length}</b></div>
      <div><small>AGAIN / HARD</small><b className="red">{counts.again} / {counts.hard}</b></div>
      <div><small>WRITING TIME</small><b className="cyan">{formatElapsedSeconds(totalWritingMs)}</b></div>
    </section>
    <section className="summary-details">
      <div className="mastery-report">
        <h2>SESSION WORDS <span>{completed.length} / {Math.max(totalMembers, completed.length)}</span></h2>
        {acquired.length === 0
          ? <p>Every card is back in its review cycle — none reached acquisition this time.</p>
          : <><small>ENTERED YOUR ACQUIRED WORDS</small><div className="next-up">{acquired.map((entry, index) => <span key={index}><HanziText text={deck.words.find((word) => word.id === entry.wordId)?.displayHanzi ?? entry.wordId} data={strokeData} /></span>)}</div></>}
      </div>
      <div className="save-report">
        <small>SAVE STATUS</small>
        <b className={saveStatus === "saved" ? "mint" : "red"}>{saveStatus === "saved" ? "✓ ALL PROGRESS SAVED" : "! PROGRESS CACHED LOCALLY"}</b>
        <button className="primary" onClick={onAgain}>LEARN AGAIN</button>
      </div>
    </section>
    <footer><button onClick={onExit}>RETURN TO GRADES</button><button className="pink-button" onClick={onAgain}>LEARN AGAIN</button></footer>
  </main>;
}
