import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_TRAVEL_MS, DANGER_ZONE_PROGRESS, MAX_ACTIVE_ENEMIES, type ChoiceKey } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin, canonicalizePinyin } from "../../domain/deck/pinyin";
import {
  advanceOrdinal,
  applyOutcomeToLevels,
  createLevelProgress,
  curriculumLessonNumber,
  curriculumOrder,
  reconcileLevelProgress,
  spawnNextWord,
  type LevelsMap,
  type SchedulerSnapshot,
} from "../../domain/learning";
import { reviewWordIdOf, spawnNextReviewWord } from "../../domain/review";
import { isUnseenWord, nextDueAtMs, type WordRatings } from "../../domain/memory";
import { createSecureRandomState } from "../../domain/random";
import { generateChoices, type MeaningChoice } from "../../domain/session/choices";
import { calculatePoints, nextStreak } from "../../domain/session/scoring";
import {
  EMPTY_BATTLEFIELD_SPAWN_DELAY_MS,
  nextPerformanceMultiplier,
  performanceAdjustedSpawnDelayMs,
} from "../../domain/session/performance";
import { advanceEnemiesForRecallWindow, moveEnemiesUp, PINYIN_RECALL_WINDOW_MS } from "../../domain/session/landing";
import { wordSpeedMultiplierForFamiliarity } from "../../domain/session/speed";
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
  ratings: WordRatings;
  /** Milliseconds until the weaker memory component is next due. */
  nextDueInMs: number | null;
  struggled: boolean;
};
export type WordSessionStats = {
  attempts: number;
  struggles: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  totalPinyinMs: number;
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

/** Progress deltas the battle applies back into the save. */
export type SaveProgressUpdate = { levels: LevelsMap; snapshot: SchedulerSnapshot };

type RegularBattleOptions = {
  kind: "regular";
  deck: RuntimeDeck;
  initialLevel: LevelProgress | undefined;
  initialSnapshot: SchedulerSnapshot;
  onChange: (update: SaveProgressUpdate, outcome?: EncounterOutcome, points?: number) => void;
};
type ReviewBattleOptions = {
  kind: "review";
  /** Merged cross-grade deck; word IDs are review keys (`deckId:wordId`). */
  deck: RuntimeDeck;
  initialLevels: LevelsMap;
  initialSnapshot: SchedulerSnapshot;
  onChange: (update: SaveProgressUpdate, outcome?: EncounterOutcome, points?: number) => void;
};
export type BattleOptions = RegularBattleOptions | ReviewBattleOptions;

const initialStats = (mode: "regular" | "review"): SessionStats => ({
  mode, score: 0, correct: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0,
  bestStreak: 0, seen: new Set(), newlyMastered: new Set(), levelsCompleted: 0, wordStats: new Map(),
});

type PreparedSpawn = {
  enemy: Enemy;
  familiarity: number;
  leadMs: number;
  startedAt: number;
  spawnAt: number;
};
type SpawnPreview = { wordId: string; leadMs: number };
type Availability = "ready" | "cooling" | "waiting" | "complete";

/** Per-profile curriculum seed so two players never share an introduction
 * order (the seeded fallback only exists for deterministic tests). */
function secureCurriculumSeed(): string {
  return createSecureRandomState().map((word) => word.toString(16).padStart(8, "0")).join("");
}

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

  const [levels, setLevels] = useState<LevelsMap>(() => {
    const snapshot = options.initialSnapshot;
    if (options.kind === "review") return { ...options.initialLevels };
    const existing = options.initialLevel;
    if (existing && existing.deckFingerprint === deck.fingerprint) return { [deck.id]: existing };
    if (existing) {
      // A deck update changed the fingerprint: reconcile stable word IDs
      // instead of silently resetting the grade's history.
      const { level } = reconcileLevelProgress(existing, deck, snapshot.spawnOrdinal);
      return { [deck.id]: level };
    }
    return {
      [deck.id]: createLevelProgress(deck, {
        curriculumSeed: secureCurriculumSeed(),
        levelSize: settings.levelSize,
        spawnOrdinal: snapshot.spawnOrdinal,
      }),
    };
  });
  const levelsRef = useRef(levels); levelsRef.current = levels;
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot>(options.initialSnapshot);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [sessionComplete, setSessionComplete] = useState(false);
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
  const availabilityRef = useRef<Availability>("ready");
  const lastOrdinalAdvance = useRef(0);
  const lastWaitingCheck = useRef(0);
  /** Enemy ids whose pinyin was revealed by the recall window; their meaning
   * phase still counts, but the pinyin component grades Again. */
  const autocompleteRevealed = useRef(new Set<string>());
  // Mid-range familiarity keeps the configured base spawn interval neutral at session start.
  const previousFamiliarity = useRef(0.5);
  const startLesson = useRef<number | null>(null);
  const lastFrame = useRef<number | null>(null);
  const enemySequence = useRef(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const optionsRef = useRef(options); optionsRef.current = options;
  const suspendedAt = useRef<number | null>(null);
  const curriculumIds = useMemo(
    () => options.kind === "regular" ? curriculumOrder(deck, levels[deck.id]?.curriculumSeed ?? "") : [],
    [deck, options.kind, levels[deck.id]?.curriculumSeed],
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
    if (options.kind === "regular") {
      const level = levels[deck.id];
      if (level && startLesson.current === null) startLesson.current = curriculumLessonNumber(level, settings.levelSize);
      preloadRegularPool(level ?? null);
    } else {
      startLesson.current = null;
      wordAudioPlayer.preload(deck.words.map((word) => wordAudioSource(deck.id, word)));
    }
  }, [deck.id, deck.words, levelKey(levels), options.kind, preloadRegularPool, settings.levelSize, wordAudioPlayer]);
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

  const updateSessionStats = useCallback((word: RuntimeWord, outcome: EncounterOutcome, pinyinMs: number, points: number, newlyMastered: boolean, struggled: boolean, levelsCompleted: number, protectsMiss: boolean) => {
    const nowStreak = nextStreak(streakRef.current, outcome.kind === "correct", protectsMiss);
    setStreak(nowStreak);
    setStats((old) => {
      const seen = new Set(old.seen).add(word.id);
      const mastered = new Set(old.newlyMastered);
      if (newlyMastered) mastered.add(word.id);
      const wordStats = new Map(old.wordStats);
      const previous = wordStats.get(word.id) ?? { attempts: 0, struggles: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, totalPinyinMs: 0 };
      wordStats.set(word.id, {
        attempts: previous.attempts + 1,
        struggles: previous.struggles + (struggled ? 1 : 0),
        wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
        totalPinyinMs: previous.totalPinyinMs + pinyinMs,
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
        levelsCompleted: Math.max(old.levelsCompleted, levelsCompleted),
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
    if (autocompleted) autocompleteRevealed.current.add(enemy.id);
    setChoices(generateChoices(deck, word, enemy.id));
    phaseRef.current = "meaning"; setPhase("meaning");
    setPinyinAutocompleted(autocompleted);
    phaseStarted.current = performance.now();
    playWordAudio(word);
  }, [deck, playWordAudio]);

  const updateWord = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    const word = words.get(enemy.wordId); if (!word) return;
    autocompleteRevealed.current.delete(enemy.id);
    nextSpawnPreview.current = undefined;
    const config = optionsRef.current;
    const pinyinMs = outcome.kind === "landed" ? 0 : outcome.pinyinMs;
    const thinking = outcome.kind === "correct" || outcome.kind === "wrongMeaning"
      ? outcome.pinyinMs + outcome.meaningMs
      : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
    const pinyinAutocompleted = (outcome.kind === "correct" || outcome.kind === "wrongMeaning")
      && outcome.pinyinAutocompleted === true;
    // The domain still receives the full two-component result so meaning can
    // be graded, but arcade/lifetime accounting treats a reveal as the pinyin
    // miss it was rather than as a complete success.
    const accountedOutcome: EncounterOutcome = pinyinAutocompleted
      ? { kind: "wrongPinyin", pinyinMs: outcome.pinyinMs }
      : outcome;
    const currentPerformanceMultiplier = performanceMultiplierRef.current;
    const effectiveSpawnIntervalMs = settings.spawnIntervalMs / currentPerformanceMultiplier;
    const points = accountedOutcome.kind === "correct"
      ? calculatePoints(
        thinking,
        streakRef.current,
        effectiveSpawnIntervalMs,
        settings.enemySpeedMultiplier * enemy.speedMultiplier * currentPerformanceMultiplier,
      )
      : 0;
    const now = new Date();
    const pinyinLength = Math.max(1, canonicalizePinyin(word.acceptedPinyin[0] ?? word.displayPinyin).length);

    let feedback: Feedback;
    let protectsMiss = false;
    const deckId = config.kind === "regular" ? config.deck.id : reviewWordIdOf(word.id).deckId;
    const wordId = config.kind === "regular" ? word.id : reviewWordIdOf(word.id).wordId;

    const previous = levelsRef.current[deckId]?.words[wordId];
    if (!previous) return;
    if (config.kind === "regular") protectsMiss = accountedOutcome.kind !== "correct" && isUnseenWord(previous);

    const result = applyOutcomeToLevels(
      levelsRef.current, deckId, wordId, outcome, now, snapshotRef.current.spawnOrdinal,
      { pinyinAutocompleted, pinyinLength },
    );
    levelsRef.current = result.levels; setLevels(result.levels);
    if (config.kind === "regular") preloadRegularPool(result.levels[config.deck.id] ?? null);

    const lessonCompleted = config.kind === "regular" && startLesson.current !== null
      ? Math.max(0, curriculumLessonNumber(result.levels[config.deck.id]!, settings.levelSize) - startLesson.current)
      : 0;
    updateSessionStats(word, accountedOutcome, pinyinMs, points, result.newlyGraduated, result.struggled, lessonCompleted, protectsMiss);
    config.onChange({ levels: result.levels, snapshot: snapshotRef.current }, accountedOutcome, points);
    feedback = {
      id: enemy.id, kind: accountedOutcome.kind === "correct" ? "correct" : accountedOutcome.kind === "landed" ? "landed" : "miss",
      word, typed, points, ratings: result.ratings,
      nextDueInMs: nextDueAtMs(result.progress) - now.getTime(),
      struggled: result.struggled,
    };

    const nowStreak = nextStreak(streakRef.current, accountedOutcome.kind === "correct", protectsMiss);
    streakRef.current = nowStreak;

    const nextMultiplier = nextPerformanceMultiplier(
      currentPerformanceMultiplier,
      accountedOutcome.kind === "correct",
      thinking,
    );
    performanceMultiplierRef.current = nextMultiplier;
    setPerformanceMultiplier(nextMultiplier);
    const at = performance.now();
    const adjustedRemaining = Math.max(0, spawnDue.current - at) * currentPerformanceMultiplier / nextMultiplier;
    spawnDue.current = at + adjustedRemaining;
    const preparing = preparingRef.current;
    if (preparing) {
      // Never accelerate a gameplay spawn past the end of its already-visible
      // pre-write animation.
      preparing.spawnAt = Math.max(spawnDue.current, preparing.startedAt + preparing.leadMs);
      spawnDue.current = preparing.spawnAt;
    } else if (enemiesRef.current.length === 0) {
      spawnDue.current = Math.min(spawnDue.current, at + EMPTY_BATTLEFIELD_SPAWN_DELAY_MS);
    }

    playSoundEffect(feedback.kind === "correct" ? "blaster" : "buzzer", settings.masterVolume);
    if (accountedOutcome.kind === "wrongPinyin" || accountedOutcome.kind === "wrongMeaning") playWordAudio(word);
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
    const now = new Date();
    if (config.kind === "regular") {
      const level = levelsRef.current[config.deck.id];
      if (!level) return null;
      const result = spawnNextWord(level, config.deck, now, snapshotRef.current, settings, excluded);
      if (result.status !== "spawned") {
        availabilityRef.current = result.status === "complete" ? "complete" : result.coolingOnly ? "cooling" : "waiting";
        return null;
      }
      availabilityRef.current = "ready";
      return { wordId: result.wordId, leadMs: strokeLeadForWord(result.wordId) };
    }
    const result = spawnNextReviewWord(levelsRef.current, now, snapshotRef.current, excluded, settings);
    if (result.status !== "spawned") {
      availabilityRef.current = "complete";
      return null;
    }
    availabilityRef.current = "ready";
    return { wordId: result.wordKey, leadMs: strokeLeadForWord(result.wordKey) };
  }, [settings, strokeLeadForWord]);

  /** Reserves the previewed scheduler result, but does not add it to the live
   * enemy list. It cannot be targeted, descend, land, or affect recall yet. */
  const prepareSpawn = useCallback((): Omit<PreparedSpawn, "leadMs" | "startedAt" | "spawnAt"> | null => {
    if (enemiesRef.current.length >= MAX_ACTIVE_ENEMIES) return null;
    const config = optionsRef.current;
    const excluded = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    const now = new Date();
    let wordId: string;
    let ordinal: number;
    let familiarity: number;
    let unseen: boolean;
    let nextSnapshot: SchedulerSnapshot;
    if (config.kind === "regular") {
      const level = levelsRef.current[config.deck.id];
      if (!level) return null;
      const result = spawnNextWord(level, config.deck, now, snapshotRef.current, settings, excluded);
      if (result.status !== "spawned") {
        availabilityRef.current = result.status === "complete" ? "complete" : result.coolingOnly ? "cooling" : "waiting";
        return null;
      }
      wordId = result.wordId; ordinal = result.spawnOrdinal;
      familiarity = result.familiarity; unseen = result.unseen;
      nextSnapshot = result.snapshot;
      levelsRef.current = { ...levelsRef.current, [config.deck.id]: result.level };
    } else {
      const result = spawnNextReviewWord(levelsRef.current, now, snapshotRef.current, excluded, settings);
      if (result.status !== "spawned") {
        availabilityRef.current = "complete";
        return null;
      }
      wordId = result.wordKey; ordinal = result.spawnOrdinal;
      familiarity = result.familiarity; unseen = false;
      nextSnapshot = result.snapshot;
      levelsRef.current = result.levels;
    }
    setLevels(levelsRef.current);
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    config.onChange({ levels: levelsRef.current, snapshot: nextSnapshot });
    setSessionComplete(false);
    const enemy: Enemy = {
      id: `e-${Date.now()}-${enemySequence.current++}`,
      wordId,
      progress: 0,
      speedMultiplier: wordSpeedMultiplierForFamiliarity(familiarity),
      isNewWord: unseen,
      lane: (ordinal * 5 + 1) % 8,
      spawnOrdinal: ordinal,
      status: "descending",
    };
    return { enemy, familiarity };
  }, [settings]);

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
          } else if (preview === null && enemiesRef.current.length === 0 && preparingRef.current === null) {
            if (availabilityRef.current === "cooling") {
              // Nothing can spawn because every due word is still ordinal-
              // blocked. Let cooldowns elapse on the empty-field clock instead
              // of ever spawning a cooling word early.
              if (now - lastOrdinalAdvance.current >= EMPTY_BATTLEFIELD_SPAWN_DELAY_MS) {
                lastOrdinalAdvance.current = now;
                snapshotRef.current = advanceOrdinal(snapshotRef.current);
                setSnapshot(snapshotRef.current);
                nextSpawnPreview.current = undefined;
              }
            } else if (availabilityRef.current === "waiting") {
              // FSRS due-ness changes with wall time. A null preview cannot be
              // cached indefinitely or a card that becomes due inside the
              // session horizon will never be observed.
              if (now - lastWaitingCheck.current >= EMPTY_BATTLEFIELD_SPAWN_DELAY_MS) {
                lastWaitingCheck.current = now;
                nextSpawnPreview.current = undefined;
              }
            } else if (availabilityRef.current === "complete") {
              setSessionComplete(true);
            }
          }
        }

        const prepared = preparingRef.current;
        if (prepared && now >= prepared.spawnAt) {
          preparingRef.current = null;
          setPreparingEnemy(null);
          commitEnemies([...enemiesRef.current, prepared.enemy], now);
          previousFamiliarity.current = prepared.familiarity;
          nextSpawnPreview.current = undefined;
          spawnDue.current = now + performanceAdjustedSpawnDelayMs(
            settings.spawnIntervalMs,
            currentPerformanceMultiplier,
            true,
            previousFamiliarity.current * 100,
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
          PINYIN_RECALL_WINDOW_MS,
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
    const pinyinAutocompleted = autocompleteRevealed.current.has(enemy.id) || undefined;
    resolveEnemy(enemy, choice.correct
      ? { kind: "correct", pinyinMs: meaningPinyinMs.current, meaningMs, pinyinAutocompleted }
      : { kind: "wrongMeaning", pinyinMs: meaningPinyinMs.current, meaningMs, pinyinAutocompleted });
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
        previousFamiliarity.current * 100,
      );
    }
  }, [settings.spawnIntervalMs]);
  const replay = () => { if (targetWord) playWordAudio(targetWord); };
  const level = options.kind === "regular" ? levels[deck.id] ?? null : null;
  return {
    enemies, preparingEnemy, target, targetWord, phase, pinyinAutocompleted, choices, feedback, learningPaused,
    audioError, streak, performanceMultiplier, stats, level, sessionComplete, submitPinyin, chooseMeaning,
    dismissFeedback, replay,
  };
}

/** Only re-run audio preloading when the pool's identity changes, not on every
 * single progress write. */
function levelKey(levels: LevelsMap): string {
  return Object.entries(levels)
    .map(([id, level]) => `${id}:${level?.curriculumCursor ?? 0}:${Object.keys(level?.words ?? {}).length}`)
    .join("|");
}
