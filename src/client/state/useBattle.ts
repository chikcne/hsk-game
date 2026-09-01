import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_TRAVEL_MS, DANGER_ZONE_PROGRESS, MAX_ACTIVE_ENEMIES, type ChoiceKey } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, ReviewProgress, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin, canonicalizePinyin } from "../../domain/deck/pinyin";
import {
  applyOutcomeToLevel,
  createLevelProgress,
  curriculumOrder,
  spawnNextWord,
  ZERO_MASTERY_APPEARANCE_WEIGHT,
} from "../../domain/learning";
import { applyReviewOutcome, prepareReviewRound, spawnNextReviewWord } from "../../domain/review";
import { randomStateFromSeed } from "../../domain/random";
import { generateChoices, type MeaningChoice } from "../../domain/session/choices";
import { calculatePoints, nextStreak } from "../../domain/session/scoring";
import {
  EMPTY_BATTLEFIELD_SPAWN_DELAY_MS,
  nextPerformanceMultiplier,
  performanceAdjustedSpawnDelayMs,
} from "../../domain/session/performance";
import { advanceEnemiesForRecallWindow, moveEnemiesUp } from "../../domain/session/landing";
import {
  masteryLevelFromAppearanceWeight,
  wordSpeedMultiplierFromAppearanceWeight,
} from "../../domain/session/speed";
import { selectLockedTarget } from "../../domain/session/targeting";
import type { Enemy, EncounterOutcome } from "../../domain/session/types";
import { playSoundEffect } from "../audio/soundEffects";
import { audioPoolWordIds, WordAudioPlayer, wordAudioSource } from "../audio/wordAudio";
import { phraseStrokeLeadMs, type StrokeDataMap } from "../data/strokeData";

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

type PreparedSpawn = {
  enemy: Enemy;
  mastery: number;
  leadMs: number;
  startedAt: number;
  spawnAt: number;
};
type SpawnPreview = { wordId: string; leadMs: number };

export function useBattle(
  options: BattleOptions,
  settings: DifficultySettings,
  paused: boolean,
  strokeData: StrokeDataMap,
  animateStrokes: boolean,
) {
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
  const [pinyinAutocompleted, setPinyinAutocompleted] = useState(false);
  const [choices, setChoices] = useState<MeaningChoice[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [learningPaused, setLearningPaused] = useState(false);
  const learningPausedRef = useRef(false); learningPausedRef.current = learningPaused;
  const [audioError, setAudioError] = useState(false);
  const [streak, setStreak] = useState(0);
  const streakRef = useRef(0); streakRef.current = streak;
  const [performanceMultiplier, setPerformanceMultiplier] = useState(1);
  const performanceMultiplierRef = useRef(1);
  const [stats, setStats] = useState<SessionStats>(() => initialStats(options.kind));
  const target = targetId === null ? null : enemies.find((enemy) => enemy.id === targetId) ?? null;
  const targetRef = useRef(target); targetRef.current = target;
  const targetWord = target ? words.get(target.wordId) ?? null : null;
  const phaseStarted = useRef(performance.now());
  const meaningPinyinMs = useRef(0);
  const spawnDue = useRef(0);
  const [preparingEnemy, setPreparingEnemy] = useState<Enemy | null>(null);
  const preparingRef = useRef<PreparedSpawn | null>(null);
  const nextSpawnPreview = useRef<SpawnPreview | null | undefined>(undefined);
  // Until the first word spawns, 50% mastery keeps the configured base interval neutral.
  const previousSpawnMastery = useRef(50);
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
    if (nextEnemies.length === 0 && preparingRef.current === null) {
      spawnDue.current = Math.min(spawnDue.current, now + EMPTY_BATTLEFIELD_SPAWN_DELAY_MS);
    }
    const nextTarget = selectLockedTarget(nextEnemies, targetIdRef.current);
    const nextTargetId = nextTarget?.id ?? null;
    if (nextTargetId !== targetIdRef.current) {
      targetIdRef.current = nextTargetId;
      targetRef.current = nextTarget;
      setTargetId(nextTargetId);
      phaseRef.current = "pinyin"; setPhase("pinyin");
      setPinyinAutocompleted(false); setChoices([]); setAudioError(false); phaseStarted.current = now;
    }
    enemiesRef.current = nextEnemies;
    setEnemies(nextEnemies);
  }, []);

  useEffect(() => {
    const suspended = paused || learningPaused || document.hidden;
    const now = performance.now();
    if (suspended && suspendedAt.current === null) suspendedAt.current = now;
    else if (!suspended && suspendedAt.current !== null) {
      const suspendedFor = now - suspendedAt.current;
      phaseStarted.current += suspendedFor;
      spawnDue.current += suspendedFor;
      if (preparingRef.current) preparingRef.current.spawnAt += suspendedFor;
      suspendedAt.current = null;
      lastFrame.current = now;
    }
  }, [learningPaused, paused]);
  useEffect(() => {
    const visibility = () => {
      const now = performance.now();
      if (document.hidden && suspendedAt.current === null) suspendedAt.current = now;
      else if (!document.hidden && suspendedAt.current !== null && !pausedRef.current && !learningPausedRef.current) {
        const suspendedFor = now - suspendedAt.current;
        phaseStarted.current += suspendedFor;
        spawnDue.current += suspendedFor;
        if (preparingRef.current) preparingRef.current.spawnAt += suspendedFor;
        suspendedAt.current = null;
        lastFrame.current = now;
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);

  const updateSessionStats = useCallback((word: RuntimeWord, outcome: EncounterOutcome, pinyinMs: number, points: number, newlyMastered: boolean, struggled: boolean, recallScore: number | null, levelsCompleted: number, protectsMiss: boolean) => {
    const nowStreak = nextStreak(streakRef.current, outcome.kind === "correct", protectsMiss);
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

  const beginMeaning = useCallback((enemy: Enemy, word: RuntimeWord, pinyinMs: number, autocompleted = false) => {
    if (targetIdRef.current !== enemy.id || phaseRef.current !== "pinyin") return;
    meaningPinyinMs.current = pinyinMs;
    setChoices(generateChoices(deck, word, enemy.id));
    phaseRef.current = "meaning"; setPhase("meaning");
    setPinyinAutocompleted(autocompleted);
    phaseStarted.current = performance.now();
    playWordAudio(word);
  }, [deck, playWordAudio]);

  const updateWord = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    const word = words.get(enemy.wordId); if (!word) return;
    nextSpawnPreview.current = undefined;
    const config = optionsRef.current;
    const pinyinMs = outcome.kind === "landed" ? 0 : outcome.pinyinMs;
    const thinking = outcome.kind === "correct" || outcome.kind === "wrongMeaning"
      ? outcome.pinyinMs + outcome.meaningMs
      : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
    const currentPerformanceMultiplier = performanceMultiplierRef.current;
    const effectiveSpawnIntervalMs = settings.spawnIntervalMs / currentPerformanceMultiplier;
    const points = outcome.kind === "correct"
      ? calculatePoints(
        thinking,
        streakRef.current,
        effectiveSpawnIntervalMs,
        settings.enemySpeedMultiplier * enemy.speedMultiplier * currentPerformanceMultiplier,
      )
      : 0;
    let feedback: Feedback;
    let protectsMiss = false;

    if (config.kind === "regular") {
      const current = levelRef.current; const previous = current?.words[word.id];
      if (!current || !previous) return;
      protectsMiss = outcome.kind !== "correct" && previous.appearanceWeight === ZERO_MASTERY_APPEARANCE_WEIGHT;
      const result = applyOutcomeToLevel(current, deck, word.id, outcome, new Date(), settings);
      // Level advancement introduces the next pool here. Start those requests
      // synchronously so the next animation frame cannot spawn first.
      preloadRegularPool(result.level);
      levelRef.current = result.level; setLevel(result.level);
      const levelsCompleted = result.transitions.filter((item) => item === "levelCompleted" || item === "sectorCompleted").length;
      updateSessionStats(word, outcome, pinyinMs, points, previous.appearanceWeight > 1 && result.progress.appearanceWeight === 1, result.struggled, null, levelsCompleted, protectsMiss);
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
      updateSessionStats(word, outcome, pinyinMs, points, false, result.struggled, result.recallScoreMsPerChar, 0, false);
      config.onChange(result.review, outcome, points);
      feedback = {
        id: enemy.id, kind: outcome.kind === "correct" ? "correct" : outcome.kind === "landed" ? "landed" : "miss",
        word, typed, points, recallScoreMsPerChar: result.recallScoreMsPerChar,
        repeatAfterPhrases: result.interval, struggled: result.struggled,
      };
    }

    const nowStreak = nextStreak(streakRef.current, outcome.kind === "correct", protectsMiss);
    streakRef.current = nowStreak;

    const nextMultiplier = nextPerformanceMultiplier(
      currentPerformanceMultiplier,
      outcome.kind === "correct",
      thinking,
      settings.struggleThresholdMs,
    );
    performanceMultiplierRef.current = nextMultiplier;
    setPerformanceMultiplier(nextMultiplier);
    const now = performance.now();
    const adjustedRemaining = Math.max(0, spawnDue.current - now) * currentPerformanceMultiplier / nextMultiplier;
    spawnDue.current = now + adjustedRemaining;
    const preparing = preparingRef.current;
    if (preparing) {
      // Never accelerate a gameplay spawn past the end of its already-visible
      // pre-write animation.
      preparing.spawnAt = Math.max(spawnDue.current, preparing.startedAt + preparing.leadMs);
      spawnDue.current = preparing.spawnAt;
    } else if (enemiesRef.current.length === 0) {
      spawnDue.current = Math.min(spawnDue.current, now + EMPTY_BATTLEFIELD_SPAWN_DELAY_MS);
    }

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
    const relieved = outcome.kind === "correct" && enemy.progress > DANGER_ZONE_PROGRESS
      ? moveEnemiesUp(remaining)
      : remaining;
    commitEnemies(relieved);
    updateWord(enemy, outcome, typed);
  }, [commitEnemies, updateWord]);

  const strokeLeadForWord = useCallback((wordId: string) => {
    if (!animateStrokes) return 0;
    const word = words.get(wordId);
    return word ? phraseStrokeLeadMs(word.displayHanzi, strokeData) : 0;
  }, [animateStrokes, strokeData, words]);

  /** Purely peeks at the deterministic scheduler. Nothing is reserved until
   * the phrase reaches its exact pre-write threshold. */
  const previewSpawn = useCallback((): SpawnPreview | null => {
    if (enemiesRef.current.length >= MAX_ACTIVE_ENEMIES) return null;
    const config = optionsRef.current;
    const excluded = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    let wordId: string;
    if (config.kind === "regular") {
      const current = levelRef.current; if (!current) return null;
      const result = spawnNextWord(current, deck, undefined, settings, excluded);
      if (result.status !== "spawned") return null;
      wordId = result.wordId;
    } else {
      const current = reviewRef.current; if (!current) return null;
      const result = spawnNextReviewWord(current, config.masteredWordKeys, excluded, undefined, settings);
      if (result.status !== "spawned") return null;
      wordId = result.wordKey;
    }
    return { wordId, leadMs: strokeLeadForWord(wordId) };
  }, [deck, settings, strokeLeadForWord]);

  /** Reserves the previewed scheduler result, but does not add it to the live
   * enemy list. It cannot be targeted, descend, land, or affect recall yet. */
  const prepareSpawn = useCallback((): Omit<PreparedSpawn, "leadMs" | "startedAt" | "spawnAt"> | null => {
    if (enemiesRef.current.length >= MAX_ACTIVE_ENEMIES) return null;
    const config = optionsRef.current;
    const excluded = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    let wordId: string;
    let ordinal: number;
    let appearanceWeight: number;
    if (config.kind === "regular") {
      const current = levelRef.current; if (!current) return null;
      const result = spawnNextWord(current, deck, undefined, settings, excluded);
      if (result.status !== "spawned") return null;
      levelRef.current = result.level; setLevel(result.level); config.onChange(result.level);
      wordId = result.wordId; ordinal = result.spawnOrdinal;
      appearanceWeight = result.level.words[wordId]?.appearanceWeight ?? ZERO_MASTERY_APPEARANCE_WEIGHT;
    } else {
      const current = reviewRef.current; if (!current) return null;
      const result = spawnNextReviewWord(current, config.masteredWordKeys, excluded, undefined, settings);
      if (result.status !== "spawned") return null;
      reviewRef.current = result.review; setReview(result.review); config.onChange(result.review);
      wordId = result.wordKey; ordinal = result.spawnOrdinal;
      appearanceWeight = 1;
    }
    setReviewComplete(false);
    const enemy: Enemy = {
      id: `e-${Date.now()}-${enemySequence.current++}`,
      wordId,
      progress: 0,
      speedMultiplier: wordSpeedMultiplierFromAppearanceWeight(appearanceWeight),
      isNewWord: config.kind === "regular" && appearanceWeight === ZERO_MASTERY_APPEARANCE_WEIGHT,
      lane: (ordinal * 5 + 1) % 8,
      spawnOrdinal: ordinal,
      status: "descending",
    };
    return { enemy, mastery: masteryLevelFromAppearanceWeight(appearanceWeight) };
  }, [deck, settings]);

  useEffect(() => {
    if (preparingRef.current === null) spawnDue.current = performance.now();
    nextSpawnPreview.current = undefined;
  }, [animateStrokes, settings.spawnIntervalMs, strokeData]);
  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (lastFrame.current === null) lastFrame.current = now;
      const delta = Math.min(100, now - lastFrame.current); lastFrame.current = now;
      if (!pausedRef.current && !learningPausedRef.current && !document.hidden) {
        const currentPerformanceMultiplier = performanceMultiplierRef.current;

        if (preparingRef.current === null && enemiesRef.current.length < MAX_ACTIVE_ENEMIES) {
          if (nextSpawnPreview.current === undefined) nextSpawnPreview.current = previewSpawn();
          const preview = nextSpawnPreview.current;
          if (preview && now >= spawnDue.current - preview.leadMs) {
            const reserved = prepareSpawn();
            if (reserved) {
              const leadMs = strokeLeadForWord(reserved.enemy.wordId);
              const prepared: PreparedSpawn = {
                ...reserved,
                leadMs,
                startedAt: now,
                spawnAt: Math.max(spawnDue.current, now + leadMs),
              };
              preparingRef.current = prepared;
              spawnDue.current = prepared.spawnAt;
              setPreparingEnemy(prepared.enemy);
            } else {
              nextSpawnPreview.current = undefined;
            }
          } else if (preview === null && optionsRef.current.kind === "review" && enemiesRef.current.length === 0) {
            setReviewComplete(true);
          }
        }

        const prepared = preparingRef.current;
        if (prepared && now >= prepared.spawnAt) {
          preparingRef.current = null;
          setPreparingEnemy(null);
          commitEnemies([...enemiesRef.current, prepared.enemy], now);
          previousSpawnMastery.current = prepared.mastery;
          nextSpawnPreview.current = undefined;
          spawnDue.current = now + performanceAdjustedSpawnDelayMs(
            settings.spawnIntervalMs,
            currentPerformanceMultiplier,
            true,
            previousSpawnMastery.current,
          );
        }

        const advance = delta / BASE_TRAVEL_MS * settings.enemySpeedMultiplier * currentPerformanceMultiplier;
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
        const autocompleted = result.autocompleted[0];
        const autocompletedWord = autocompleted ? words.get(autocompleted.wordId) : null;
        if (autocompleted && autocompletedWord) beginMeaning(autocompleted, autocompletedWord, activeRecallMs, true);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [beginMeaning, commitEnemies, prepareSpawn, previewSpawn, settings.enemySpeedMultiplier, settings.spawnIntervalMs, strokeLeadForWord, updateWord, words]);

  const submitPinyin = (raw: string) => {
    const enemy = targetRef.current; const word = enemy ? words.get(enemy.wordId) : null;
    if (!enemy || !word || !raw.trim() || phase !== "pinyin" || pausedRef.current || learningPausedRef.current) return;
    const elapsed = performance.now() - phaseStarted.current;
    if (acceptsPinyin(word.acceptedPinyin, raw)) beginMeaning(enemy, word, elapsed);
    else resolveEnemy(enemy, { kind: "wrongPinyin", pinyinMs: elapsed }, raw);
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
    if (suspendedAt.current !== null) {
      const suspendedFor = now - suspendedAt.current;
      spawnDue.current += suspendedFor;
      if (preparingRef.current) preparingRef.current.spawnAt += suspendedFor;
    }
    suspendedAt.current = null;
    phaseStarted.current = now; lastFrame.current = now;
    if (preparingRef.current === null) {
      spawnDue.current = now + performanceAdjustedSpawnDelayMs(
        settings.spawnIntervalMs,
        performanceMultiplierRef.current,
        enemiesRef.current.length > 0,
        previousSpawnMastery.current,
      );
    }
  }, [settings.spawnIntervalMs]);
  const replay = () => { if (targetWord) playWordAudio(targetWord); };
  return { enemies, preparingEnemy, target, targetWord, phase, pinyinAutocompleted, choices, feedback, learningPaused, audioError, streak, performanceMultiplier, stats, level, review, reviewComplete, submitPinyin, chooseMeaning, dismissFeedback, replay };
}
