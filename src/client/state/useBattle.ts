import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_TRAVEL_MS, MAX_ACTIVE_ENEMIES, type ChoiceKey } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, ReviewProgress, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin, canonicalizePinyin } from "../../domain/deck/pinyin";
import { applyOutcomeToLevel, createLevelProgress, curriculumOrder, spawnNextWord } from "../../domain/learning";
import { applyReviewOutcome, prepareReviewRound, spawnNextReviewWord } from "../../domain/review";
import { randomStateFromSeed } from "../../domain/random";
import { generateChoices, type MeaningChoice } from "../../domain/session/choices";
import { calculatePoints } from "../../domain/session/scoring";
import { advanceEnemiesForRecallWindow } from "../../domain/session/landing";
import { wordSpeedMultiplierFromAppearanceWeight } from "../../domain/session/speed";
import { selectLockedTarget } from "../../domain/session/targeting";
import type { Enemy, EncounterOutcome } from "../../domain/session/types";
import { playSoundEffect } from "../audio/soundEffects";
import { audioPoolWordIds, WordAudioPlayer, wordAudioSource } from "../audio/wordAudio";

export type Feedback = {
  id: string;
  kind: "correct" | "miss" | "landed";
  word: RuntimeWord;
  typed?: string;
  points?: number;
  oldWeight?: number;
  newWeight?: number;
  recallScoreMsPerChar?: number | null;
  repeatAfterPhrases?: number;
  struggled: boolean;
};
export type WordSessionStats = {
  attempts: number;
  struggles: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  totalPinyinMs: number;
  recallScoreMsPerChar: number | null;
};
export type SessionStats = {
  mode: "regular" | "review";
  score: number;
  correct: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  bestStreak: number;
  seen: Set<string>;
  newlyMastered: Set<string>;
  levelsCompleted: number;
  wordStats: Map<string, WordSessionStats>;
};

export const createLevel = (deck: RuntimeDeck, settings: DifficultySettings): LevelProgress => createLevelProgress(deck, {
  schedulerRng: randomStateFromSeed(`schedule:${deck.fingerprint}`),
  curriculumSeed: `curriculum:${deck.fingerprint}`,
  levelSize: settings.levelSize,
});

type RegularBattleOptions = {
  kind: "regular";
  deck: RuntimeDeck;
  initialLevel: LevelProgress | undefined;
  onChange: (level: LevelProgress, outcome?: EncounterOutcome, points?: number) => void;
};
type ReviewBattleOptions = {
  kind: "review";
  deck: RuntimeDeck;
  initialReview: ReviewProgress;
  masteredWordKeys: ReadonlySet<string>;
  onChange: (review: ReviewProgress, outcome?: EncounterOutcome, points?: number) => void;
};
export type BattleOptions = RegularBattleOptions | ReviewBattleOptions;

const initialStats = (mode: "regular" | "review"): SessionStats => ({
  mode, score: 0, correct: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0,
  bestStreak: 0, seen: new Set(), newlyMastered: new Set(), levelsCompleted: 0, wordStats: new Map(),
});

export function useBattle(options: BattleOptions, settings: DifficultySettings, paused: boolean) {
  const { deck } = options;
  const words = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const wordAudioPlayer = useMemo(() => new WordAudioPlayer(), [deck.fingerprint]);
  const [level, setLevel] = useState<LevelProgress | null>(() => options.kind === "regular"
    ? options.initialLevel?.deckFingerprint === deck.fingerprint ? options.initialLevel : createLevel(deck, settings)
    : null);
  const levelRef = useRef(level); levelRef.current = level;
  const [review, setReview] = useState<ReviewProgress | null>(() => options.kind === "review"
    ? prepareReviewRound(options.initialReview, options.masteredWordKeys)
    : null);
  const reviewRef = useRef(review); reviewRef.current = review;
  const [reviewComplete, setReviewComplete] = useState(false);
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const enemiesRef = useRef(enemies); enemiesRef.current = enemies;
  const [targetId, setTargetId] = useState<string | null>(null);
  const targetIdRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<"pinyin" | "meaning">("pinyin");
  const phaseRef = useRef<"pinyin" | "meaning">("pinyin");
  const [choices, setChoices] = useState<MeaningChoice[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [learningPaused, setLearningPaused] = useState(false);
  const learningPausedRef = useRef(false); learningPausedRef.current = learningPaused;
  const [audioError, setAudioError] = useState(false);
  const [streak, setStreak] = useState(0);
  const streakRef = useRef(0); streakRef.current = streak;
  const [stats, setStats] = useState<SessionStats>(() => initialStats(options.kind));
  const target = targetId === null ? null : enemies.find((enemy) => enemy.id === targetId) ?? null;
  const targetRef = useRef(target); targetRef.current = target;
  const targetWord = target ? words.get(target.wordId) ?? null : null;
  const phaseStarted = useRef(performance.now());
  const meaningPinyinMs = useRef(0);
  const spawnDue = useRef(0);
  const lastFrame = useRef<number | null>(null);
  const enemySequence = useRef(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const optionsRef = useRef(options); optionsRef.current = options;
  const suspendedAt = useRef<number | null>(null);
  const curriculumIds = useMemo(
    () => level ? curriculumOrder(deck, level.curriculumSeed) : [],
    [deck, level?.curriculumSeed],
  );

  const preloadRegularPool = useCallback((poolLevel: LevelProgress | null) => {
    if (!poolLevel) return;
    const sources = audioPoolWordIds(poolLevel, curriculumIds).flatMap((id) => {
      const word = words.get(id);
      return word ? [wordAudioSource(deck.id, word)] : [];
    });
    wordAudioPlayer.preload(sources);
  }, [curriculumIds, deck.id, wordAudioPlayer, words]);
  useEffect(() => {
    if (options.kind === "regular") preloadRegularPool(level);
    else wordAudioPlayer.preload(deck.words.map((word) => wordAudioSource(deck.id, word)));
  }, [deck.id, deck.words, level, options.kind, preloadRegularPool, wordAudioPlayer]);
  useEffect(() => () => wordAudioPlayer.dispose(), [wordAudioPlayer]);

  const commitEnemies = useCallback((nextEnemies: Enemy[], now = performance.now()) => {
    const nextTarget = selectLockedTarget(nextEnemies, targetIdRef.current);
    const nextTargetId = nextTarget?.id ?? null;
    if (nextTargetId !== targetIdRef.current) {
      targetIdRef.current = nextTargetId;
      targetRef.current = nextTarget;
      setTargetId(nextTargetId);
      phaseRef.current = "pinyin"; setPhase("pinyin");
      setChoices([]); setAudioError(false); phaseStarted.current = now;
    }
    enemiesRef.current = nextEnemies;
    setEnemies(nextEnemies);
  }, []);

  useEffect(() => {
    const suspended = paused || learningPaused || document.hidden;
    const now = performance.now();
    if (suspended && suspendedAt.current === null) suspendedAt.current = now;
    else if (!suspended && suspendedAt.current !== null) {
      phaseStarted.current += now - suspendedAt.current;
      suspendedAt.current = null;
      lastFrame.current = now;
    }
  }, [learningPaused, paused]);
  useEffect(() => {
    const visibility = () => {
      const now = performance.now();
      if (document.hidden && suspendedAt.current === null) suspendedAt.current = now;
      else if (!document.hidden && suspendedAt.current !== null && !pausedRef.current && !learningPausedRef.current) {
        phaseStarted.current += now - suspendedAt.current;
        suspendedAt.current = null;
        lastFrame.current = now;
        spawnDue.current = now + settings.spawnIntervalMs;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [settings.spawnIntervalMs]);

  const updateSessionStats = useCallback((word: RuntimeWord, outcome: EncounterOutcome, pinyinMs: number, points: number, newlyMastered: boolean, struggled: boolean, recallScore: number | null, levelsCompleted: number) => {
    const nowStreak = outcome.kind === "correct" ? streakRef.current + 1 : 0;
    setStreak(nowStreak);
    setStats((old) => {
      const seen = new Set(old.seen).add(word.id);
      const mastered = new Set(old.newlyMastered);
      if (newlyMastered) mastered.add(word.id);
      const wordStats = new Map(old.wordStats);
      const previous = wordStats.get(word.id) ?? { attempts: 0, struggles: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, totalPinyinMs: 0, recallScoreMsPerChar: null };
      wordStats.set(word.id, {
        attempts: previous.attempts + 1,
        struggles: previous.struggles + (struggled ? 1 : 0),
        wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
        totalPinyinMs: previous.totalPinyinMs + pinyinMs,
        recallScoreMsPerChar: recallScore,
      });
      return {
        ...old,
        score: old.score + points,
        correct: old.correct + (outcome.kind === "correct" ? 1 : 0),
        wrongPinyin: old.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: old.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: old.landed + (outcome.kind === "landed" ? 1 : 0),
        bestStreak: Math.max(old.bestStreak, nowStreak),
        seen,
        newlyMastered: mastered,
        levelsCompleted: old.levelsCompleted + levelsCompleted,
        wordStats,
      };
    });
  }, []);

  const playWordAudio = useCallback((word: RuntimeWord) => {
    const source = wordAudioSource(deck.id, word);
    if (!source) return;
    void wordAudioPlayer.play(source, settings.masterVolume)
      .then(() => setAudioError(false))
      .catch(() => setAudioError(true));
  }, [deck.id, settings.masterVolume, wordAudioPlayer]);

  const updateWord = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    const word = words.get(enemy.wordId); if (!word) return;
    const config = optionsRef.current;
    const pinyinMs = outcome.kind === "landed" ? 0 : outcome.pinyinMs;
    const thinking = outcome.kind === "correct" || outcome.kind === "wrongMeaning"
      ? outcome.pinyinMs + outcome.meaningMs
      : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
    const points = outcome.kind === "correct"
      ? calculatePoints(thinking, streakRef.current, settings.spawnIntervalMs, settings.enemySpeedMultiplier * enemy.speedMultiplier)
      : 0;
    let feedback: Feedback;

    if (config.kind === "regular") {
      const current = levelRef.current; const previous = current?.words[word.id];
      if (!current || !previous) return;
      const result = applyOutcomeToLevel(current, deck, word.id, outcome, new Date(), settings);
      // Level advancement introduces the next pool here. Start those requests
      // synchronously so the next animation frame cannot spawn first.
      preloadRegularPool(result.level);
      levelRef.current = result.level; setLevel(result.level);
      const levelsCompleted = result.transitions.filter((item) => item === "levelCompleted" || item === "sectorCompleted").length;
      updateSessionStats(word, outcome, pinyinMs, points, previous.appearanceWeight > 1 && result.progress.appearanceWeight === 1, result.struggled, null, levelsCompleted);
      config.onChange(result.level, outcome, points);
      feedback = {
        id: enemy.id, kind: outcome.kind === "correct" ? "correct" : outcome.kind === "landed" ? "landed" : "miss",
        word, typed, points, oldWeight: previous.appearanceWeight, newWeight: result.progress.appearanceWeight,
        repeatAfterPhrases: result.repeatAfterPhrases, struggled: result.struggled,
      };
    } else {
      const current = reviewRef.current; if (!current) return;
      const pinyinLength = Math.max(1, canonicalizePinyin(word.acceptedPinyin[0] ?? word.displayPinyin).length);
      const result = applyReviewOutcome(current, word.id, outcome, pinyinLength, new Date(), settings);
      reviewRef.current = result.review; setReview(result.review); setReviewComplete(false);
      updateSessionStats(word, outcome, pinyinMs, points, false, result.struggled, result.recallScoreMsPerChar, 0);
      config.onChange(result.review, outcome, points);
      feedback = {
        id: enemy.id, kind: outcome.kind === "correct" ? "correct" : outcome.kind === "landed" ? "landed" : "miss",
        word, typed, points, recallScoreMsPerChar: result.recallScoreMsPerChar,
        repeatAfterPhrases: result.interval, struggled: result.struggled,
      };
    }

    const nowStreak = outcome.kind === "correct" ? streakRef.current + 1 : 0;
    streakRef.current = nowStreak;
    playSoundEffect(feedback.kind === "correct" ? "blaster" : "buzzer", settings.masterVolume);
    if (outcome.kind === "wrongPinyin" || outcome.kind === "wrongMeaning") playWordAudio(word);
    setFeedback(feedback);
    if (feedback.kind !== "correct") {
      learningPausedRef.current = true; setLearningPaused(true);
    } else {
      window.setTimeout(() => setFeedback((item) => item?.id === enemy.id ? null : item), 1100);
    }
  }, [deck, playWordAudio, preloadRegularPool, settings, updateSessionStats, words]);

  const resolveEnemy = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    if (!enemiesRef.current.some((item) => item.id === enemy.id)) return;
    const remaining = enemiesRef.current.filter((item) => item.id !== enemy.id);
    commitEnemies(remaining);
    updateWord(enemy, outcome, typed);
  }, [commitEnemies, updateWord]);

  const spawn = useCallback(() => {
    if (enemiesRef.current.length >= MAX_ACTIVE_ENEMIES) return;
    const config = optionsRef.current;
    const excluded = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    let wordId: string;
    let ordinal: number;
    let appearanceWeight: number;
    if (config.kind === "regular") {
      const current = levelRef.current; if (!current) return;
      const result = spawnNextWord(current, deck, undefined, settings, excluded);
      if (result.status !== "spawned") return;
      levelRef.current = result.level; setLevel(result.level); config.onChange(result.level);
      wordId = result.wordId; ordinal = result.spawnOrdinal;
      appearanceWeight = result.level.words[wordId]?.appearanceWeight ?? 100;
    } else {
      const current = reviewRef.current; if (!current) return;
      const result = spawnNextReviewWord(current, config.masteredWordKeys, excluded, undefined, settings);
      if (result.status !== "spawned") {
        if (enemiesRef.current.length === 0) setReviewComplete(true);
        return;
      }
      reviewRef.current = result.review; setReview(result.review); config.onChange(result.review);
      wordId = result.wordKey; ordinal = result.spawnOrdinal;
      appearanceWeight = 1;
    }
    setReviewComplete(false);
    const lane = (ordinal * 5 + 1) % 8;
    const enemy: Enemy = {
      id: `e-${Date.now()}-${enemySequence.current++}`,
      wordId,
      progress: 0,
      speedMultiplier: wordSpeedMultiplierFromAppearanceWeight(appearanceWeight),
      lane,
      spawnOrdinal: ordinal,
      status: "descending",
    };
    commitEnemies([...enemiesRef.current, enemy]);
  }, [commitEnemies, deck, settings]);

  useEffect(() => { spawnDue.current = performance.now(); }, [settings.spawnIntervalMs]);
  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (lastFrame.current === null) lastFrame.current = now;
      const delta = Math.min(100, now - lastFrame.current); lastFrame.current = now;
      if (!pausedRef.current && !learningPausedRef.current && !document.hidden) {
        if (now >= spawnDue.current) { spawn(); spawnDue.current = now + settings.spawnIntervalMs; }
        const advance = delta / BASE_TRAVEL_MS * settings.enemySpeedMultiplier;
        const lockedTargetId = targetIdRef.current;
        const activeRecallMs = lockedTargetId === null ? 0 : Math.max(0, now - phaseStarted.current);
        const result = advanceEnemiesForRecallWindow(
          enemiesRef.current,
          advance,
          lockedTargetId,
          phaseRef.current,
          activeRecallMs,
          settings.struggleThresholdMs,
        );
        commitEnemies(result.active, now);
        for (const enemy of result.landed) updateWord(enemy, { kind: "landed", activeThinkingMs: activeRecallMs });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [commitEnemies, settings.enemySpeedMultiplier, settings.spawnIntervalMs, spawn, updateWord]);

  const submitPinyin = (raw: string) => {
    const enemy = targetRef.current; const word = enemy ? words.get(enemy.wordId) : null;
    if (!enemy || !word || !raw.trim() || phase !== "pinyin" || pausedRef.current || learningPausedRef.current) return;
    const elapsed = performance.now() - phaseStarted.current;
    if (acceptsPinyin(word.acceptedPinyin, raw)) {
      meaningPinyinMs.current = elapsed; setChoices(generateChoices(deck, word, enemy.id));
      phaseRef.current = "meaning"; setPhase("meaning"); phaseStarted.current = performance.now(); playWordAudio(word);
    } else resolveEnemy(enemy, { kind: "wrongPinyin", pinyinMs: elapsed }, raw);
  };
  const chooseMeaning = (key: ChoiceKey) => {
    const enemy = targetRef.current;
    if (!enemy || phase !== "meaning" || pausedRef.current || learningPausedRef.current) return;
    const choice = choices.find((item) => item.shortcuts.some((shortcut) => shortcut.key === key)); if (!choice) return;
    const meaningMs = performance.now() - phaseStarted.current;
    resolveEnemy(enemy, choice.correct
      ? { kind: "correct", pinyinMs: meaningPinyinMs.current, meaningMs }
      : { kind: "wrongMeaning", pinyinMs: meaningPinyinMs.current, meaningMs });
  };
  const dismissFeedback = useCallback(() => {
    if (!learningPausedRef.current) return;
    learningPausedRef.current = false; setLearningPaused(false);
    setFeedback((item) => item?.kind !== "correct" ? null : item);
    const now = performance.now();
    suspendedAt.current = null;
    phaseStarted.current = now; lastFrame.current = now;
    spawnDue.current = now + settings.spawnIntervalMs;
  }, [settings.spawnIntervalMs]);
  const replay = () => { if (targetWord) playWordAudio(targetWord); };
  return { enemies, target, targetWord, phase, choices, feedback, learningPaused, audioError, streak, stats, level, review, reviewComplete, submitPinyin, chooseMeaning, dismissFeedback, replay };
}
