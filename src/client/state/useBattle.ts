import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_TRAVEL_MS, DANGER_ZONE_PROGRESS, MAX_ACTIVE_ENEMIES, type ChoiceKey,
} from "../../shared/constants";
import type { DifficultySettings, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin } from "../../domain/deck/pinyin";
import type { SchedulerSnapshot } from "../../domain/learning";
import type { RecencyLabel, ReviewPlan, ReviewSession, ReviewSpawnDecision } from "../../domain/review";
import {
  applyReviewOutcome, createReviewSession, decideReviewSpawn, pendingReviewWork, reserveReviewSpawn,
} from "../../domain/review";
import { safeMeaningChoices, type MeaningChoice } from "../../domain/session/choices";
import { calculatePoints, nextStreak } from "../../domain/session/scoring";
import { encounterCredit } from "../../domain/session/credit";
import {
  EMPTY_BATTLEFIELD_SPAWN_DELAY_MS,
  emptyFieldWriteSchedule,
  gameplayWriteSchedule,
  nextPerformanceMultiplier,
  performanceAdjustedSpawnDelayMs,
} from "../../domain/session/performance";
import { advanceEnemiesForRecallWindow, moveEnemiesUp, PINYIN_RECALL_WINDOW_MS } from "../../domain/session/landing";
import { wordSpeedMultiplierForFamiliarity } from "../../domain/session/speed";
import { selectLockedTarget } from "../../domain/session/targeting";
import type { Enemy, EncounterOutcome } from "../../domain/session/types";
import { playSoundEffect } from "../audio/soundEffects";
import { WordAudioPlayer, wordAudioSource } from "../audio/wordAudio";
import { phraseStrokeLeadMs, type StrokeDataMap } from "../data/strokeData";

export type Feedback = {
  id: string;
  kind: "correct" | "miss" | "landed";
  word: RuntimeWord;
  typed?: string;
  points?: number;
  /** True when the pinyin was revealed by the recall window and the meaning
   * answer then succeeded: a miss with a retry obligation — never presented
   * as a clean DIRECT HIT, scoring no points and resetting the streak. */
  revealed?: boolean;
};
export type WordSessionStats = {
  attempts: number;
  /** Total miss events: wrong pinyin/meaning, landings, and pinyin
   * autocomplete reveals — even when the meaning was then correct. */
  misses: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  /** Pinyin autocomplete reveals (a subset of `misses`). */
  autocompleted: number;
  totalPinyinMs: number;
  /** New/Recent/Old tier captured when the session started. */
  recency: RecencyLabel;
};
export type SessionStats = {
  mode: "review";
  score: number;
  correct: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  bestStreak: number;
  /** Unique word keys served (a word can serve multiple times). */
  seen: Set<string>;
  wordStats: Map<string, WordSessionStats>;
  /** Exact length of the deterministic base plan (the settings target). */
  baseSpawns: number;
  /** Every resolved enemy: base-plan spawns plus additive repair retries.
   * Progress is tracked per resolved spawn, not per unique word. */
  resolvedSpawns: number;
  /** Additive retry spawns served beyond the base plan so far. */
  repairSpawns: number;
  /** Repair obligations cleared by a clean, fully correct encounter. */
  clearedRepairs: number;
};

/** Review battles never mutate the main FSRS cards; the coordinator receives
 * the advanced scheduler snapshot plus the outcome for lifetime counters. */
export type ReviewProgressReport = {
  snapshot: SchedulerSnapshot;
  outcome?: EncounterOutcome;
  points: number;
};

export type BattleOptions = {
  /** Merged cross-grade deck; word IDs are review keys (`deckId:wordId`). */
  deck: RuntimeDeck;
  /** Deterministic nonpersisted spawn plan built from `acquired_words`. */
  plan: ReviewPlan;
  /** Snapshot after plan creation; spawns advance its ordinal. */
  initialSnapshot: SchedulerSnapshot;
  onChange: (report: ReviewProgressReport) => void;
};

const initialStats = (baseSpawns: number): SessionStats => ({
  mode: "review", score: 0, correct: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0,
  bestStreak: 0, seen: new Set(), wordStats: new Map(),
  baseSpawns, resolvedSpawns: 0, repairSpawns: 0, clearedRepairs: 0,
});

type PreparedSpawn = {
  enemy: Enemy;
  /** Recency pressure 0..1 of the spawned word (spawn-delay adjustment). */
  pressure: number;
  leadMs: number;
  startedAt: number;
  spawnAt: number;
};

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

  const planRecencyRef = useRef(options.plan.recency);
  const planPressureRef = useRef(options.plan.pressure);
  /** Pure spawn/obligation coordination over the immutable plan. */
  const reviewSessionRef = useRef<ReviewSession>(createReviewSession(options.plan.spawns));
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot>(options.initialSnapshot);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [sessionComplete, setSessionComplete] = useState(false);
  const sessionCompleteRef = useRef(false);
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
  const [stats, setStats] = useState<SessionStats>(() => initialStats(options.plan.spawns.length));
  const target = targetId === null ? null : enemies.find((enemy) => enemy.id === targetId) ?? null;
  const targetRef = useRef(target); targetRef.current = target;
  const targetWord = target ? words.get(target.wordId) ?? null : null;
  const phaseStarted = useRef(performance.now());
  const meaningPinyinMs = useRef(0);
  const spawnDue = useRef(0);
  const [preparingEnemy, setPreparingEnemy] = useState<Enemy | null>(null);
  const preparingRef = useRef<PreparedSpawn | null>(null);
  /** Enemy ids whose pinyin was revealed by the recall window; their meaning
   * phase still counts toward session stats — and counts as a miss even if
   * the meaning answer is correct. */
  const autocompleteRevealed = useRef(new Set<string>());
  // Neutral 0.5 pressure keeps the configured base spawn interval at session start.
  const previousPressure = useRef(0.5);
  const lastFrame = useRef<number | null>(null);
  const enemySequence = useRef(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const optionsRef = useRef(options); optionsRef.current = options;
  const suspendedAt = useRef<number | null>(null);

  useEffect(() => {
    wordAudioPlayer.preload(deck.words.map((word) => wordAudioSource(deck.id, word)));
    return () => wordAudioPlayer.dispose();
  }, [deck, wordAudioPlayer]);

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

  const updateSessionStats = useCallback((
    word: RuntimeWord,
    outcome: EncounterOutcome,
    pinyinMs: number,
    points: number,
    missed: boolean,
    autocompleted: boolean,
    clearedRepair: boolean,
  ) => {
    const credit = encounterCredit(outcome, autocompleted);
    const nowStreak = nextStreak(streakRef.current, credit.streakContinues, false);
    setStreak(nowStreak);
    setStats((old) => {
      const seen = new Set(old.seen).add(word.id);
      const wordStats = new Map(old.wordStats);
      const previous = wordStats.get(word.id) ?? {
        attempts: 0, misses: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, autocompleted: 0,
        totalPinyinMs: 0, recency: planRecencyRef.current.get(word.id) ?? "old",
      };
      wordStats.set(word.id, {
        attempts: previous.attempts + 1,
        misses: previous.misses + (missed ? 1 : 0),
        wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
        autocompleted: previous.autocompleted + (autocompleted ? 1 : 0),
        totalPinyinMs: previous.totalPinyinMs + pinyinMs,
        recency: previous.recency,
      });
      return {
        ...old,
        score: old.score + points,
        // A revealed-then-meaning-correct encounter is a miss, not a clean
        // recall: it counts toward misses and never inflates accuracy.
        correct: old.correct + (credit.countsAsCorrect ? 1 : 0),
        wrongPinyin: old.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: old.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: old.landed + (outcome.kind === "landed" ? 1 : 0),
        bestStreak: Math.max(old.bestStreak, nowStreak),
        seen,
        wordStats,
        resolvedSpawns: old.resolvedSpawns + 1,
        clearedRepairs: old.clearedRepairs + (clearedRepair ? 1 : 0),
      };
    });
  }, []);

  const playWordAudio = useCallback((word: RuntimeWord) => {
    const source = wordAudioSource(deck.id, word);
    if (!source) return;
    Effect.runFork(wordAudioPlayer.playEffect(source, settings.masterVolume).pipe(
      Effect.match({
        onFailure: () => setAudioError(true),
        onSuccess: () => setAudioError(false),
      }),
    ));
  }, [deck.id, settings.masterVolume, wordAudioPlayer]);

  const beginMeaning = useCallback((enemy: Enemy, word: RuntimeWord, pinyinMs: number, autocompleted = false) => {
    if (targetIdRef.current !== enemy.id || phaseRef.current !== "pinyin") return;
    meaningPinyinMs.current = pinyinMs;
    if (autocompleted) autocompleteRevealed.current.add(enemy.id);
    // Safe by contract: choice generation can never throw here, so a
    // pathological deck can never terminate the rAF frame loop.
    setChoices(safeMeaningChoices(deck, word, enemy.id));
    phaseRef.current = "meaning"; setPhase("meaning");
    setPinyinAutocompleted(autocompleted);
    phaseStarted.current = performance.now();
    playWordAudio(word);
  }, [deck, playWordAudio]);

  /**
   * Picks what the next spawn should be via the pure review-session
   * reducer: due repair obligations (oldest first, never concurrently
   * active) outrank the next base-plan spawn; waiting is safe only while a
   * candidate word is still active; completion additionally requires an
   * empty battlefield (checked at the call site).
   */
  const decideSpawn = useCallback((): ReviewSpawnDecision => {
    const activeKeys = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    if (preparingRef.current) activeKeys.add(preparingRef.current.enemy.wordId);
    return decideReviewSpawn(reviewSessionRef.current, activeKeys);
  }, []);

  /** Reserves a decided spawn: advances the snapshot ordinal, consumes one
   * base-plan slot or counts one additive repair, and builds the enemy. The
   * reservation is atomic with the decision — both happen in one frame. */
  const reserveSpawn = useCallback((decision: Extract<ReviewSpawnDecision, { kind: "spawn" }>): PreparedSpawn | null => {
    const word = words.get(decision.wordKey);
    if (!word) return null;
    reviewSessionRef.current = reserveReviewSpawn(reviewSessionRef.current, decision);
    const ordinal = snapshotRef.current.spawnOrdinal;
    const nextSnapshot: SchedulerSnapshot = {
      spawnOrdinal: ordinal + 1,
      schedulerRng: snapshotRef.current.schedulerRng,
    };
    snapshotRef.current = nextSnapshot;
    setSnapshot(nextSnapshot);
    optionsRef.current.onChange({ snapshot: nextSnapshot, points: 0 });
    if (decision.source === "repair") setStats((old) => ({ ...old, repairSpawns: old.repairSpawns + 1 }));
    const pressure = planPressureRef.current.get(decision.wordKey) ?? 0.5;
    const enemy: Enemy = {
      id: `e-${Date.now()}-${enemySequence.current++}`,
      wordId: decision.wordKey,
      progress: 0,
      speedMultiplier: wordSpeedMultiplierForFamiliarity(pressure),
      isNewWord: false,
      lane: (ordinal * 5 + 1) % 8,
      spawnOrdinal: ordinal,
      status: "descending",
    };
    return { enemy, pressure, leadMs: 0, startedAt: 0, spawnAt: 0 };
  }, [words]);

  const updateWord = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    const word = words.get(enemy.wordId); if (!word) return;
    const wasRevealed = autocompleteRevealed.current.has(enemy.id);
    autocompleteRevealed.current.delete(enemy.id);
    // A clean, fully correct encounter (typed pinyin, correct meaning, no
    // reveal) clears the word's repair obligation. Any miss — wrong pinyin,
    // wrong meaning, a landing, or an autocomplete reveal even when the
    // meaning is then correct — (re)queues it with a fresh delay.
    const cleanCorrect = outcome.kind === "correct" && !wasRevealed;
    const appliedOutcome = applyReviewOutcome(reviewSessionRef.current, word.id, cleanCorrect);
    reviewSessionRef.current = appliedOutcome.session;
    const clearedRepair = appliedOutcome.cleared;
    const pinyinMs = outcome.kind === "landed" ? 0 : outcome.pinyinMs;
    const thinking = outcome.kind === "correct" || outcome.kind === "wrongMeaning"
      ? outcome.pinyinMs + outcome.meaningMs
      : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
    const currentPerformanceMultiplier = performanceMultiplierRef.current;
    const effectiveSpawnIntervalMs = settings.spawnIntervalMs / currentPerformanceMultiplier;
    const credit = encounterCredit(outcome, wasRevealed);
    // A revealed pinyin forfeits the round's reward: the encounter resolves
    // (the meaning answer stands) but scores nothing and resets the streak.
    const points = credit.earnsPoints
      ? calculatePoints(
        thinking,
        streakRef.current,
        effectiveSpawnIntervalMs,
        settings.enemySpeedMultiplier * enemy.speedMultiplier * currentPerformanceMultiplier,
      )
      : 0;

    // Review battles leave every FSRS card untouched; only the lifetime
    // counters and the global scheduler snapshot advance.
    const report: ReviewProgressReport = { snapshot: snapshotRef.current, outcome, points };
    optionsRef.current.onChange(report);
    updateSessionStats(word, outcome, pinyinMs, points, !cleanCorrect, wasRevealed, clearedRepair);

    const feedback: Feedback = {
      id: enemy.id,
      kind: outcome.kind === "correct" ? "correct" : outcome.kind === "landed" ? "landed" : "miss",
      word, typed, points,
      revealed: wasRevealed || undefined,
    };

    const nowStreak = nextStreak(streakRef.current, credit.streakContinues, false);
    streakRef.current = nowStreak;

    const nextMultiplier = nextPerformanceMultiplier(
      currentPerformanceMultiplier,
      outcome.kind === "correct",
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
    if (outcome.kind === "wrongPinyin" || outcome.kind === "wrongMeaning") playWordAudio(word);
    setFeedback(feedback);
    if (feedback.kind !== "correct") {
      learningPausedRef.current = true; setLearningPaused(true);
    } else {
      window.setTimeout(() => setFeedback((item) => item?.id === enemy.id ? null : item), 1100);
    }
  }, [playWordAudio, settings, updateSessionStats, words]);

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

  useEffect(() => {
    if (preparingRef.current === null) spawnDue.current = performance.now();
  }, [animateStrokes, settings.spawnIntervalMs, strokeData]);
  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (lastFrame.current === null) lastFrame.current = now;
      const delta = Math.min(100, now - lastFrame.current); lastFrame.current = now;
      if (!pausedRef.current && !learningPausedRef.current && !document.hidden) {
        const currentPerformanceMultiplier = performanceMultiplierRef.current;

        if (preparingRef.current === null && enemiesRef.current.length < MAX_ACTIVE_ENEMIES) {
          const decision = decideSpawn();
          if (decision.kind === "spawn") {
            const fullLeadMs = strokeLeadForWord(decision.wordKey);
            if (now >= spawnDue.current - fullLeadMs) {
              const reserved = reserveSpawn(decision);
              if (reserved) {
                // An empty battlefield must serve the next word within the
                // two-second budget: its write compresses instead of serializing
                // the full stroke lead after the board already cleared. With
                // enemies still up, gameplay pacing keeps natural cadence.
                const schedule = enemiesRef.current.length === 0
                  ? emptyFieldWriteSchedule(now, spawnDue.current, fullLeadMs)
                  : gameplayWriteSchedule(now, spawnDue.current, fullLeadMs);
                const prepared: PreparedSpawn = {
                  ...reserved,
                  leadMs: schedule.writeMs,
                  startedAt: now,
                  spawnAt: schedule.spawnAtMs,
                };
                preparingRef.current = prepared;
                spawnDue.current = prepared.spawnAt;
                setPreparingEnemy(schedule.writeSpeed === 1 ? reserved.enemy : { ...reserved.enemy, writeSpeed: schedule.writeSpeed });
              }
            }
          } else if (
            decision.kind === "complete"
            && enemiesRef.current.length === 0
            && !sessionCompleteRef.current
          ) {
            // The base plan is fully resolved, no repair obligation remains,
            // and the battlefield (active AND preparing enemies) is empty.
            sessionCompleteRef.current = true;
            setSessionComplete(true);
          }
        }

        const prepared = preparingRef.current;
        if (prepared && now >= prepared.spawnAt) {
          preparingRef.current = null;
          setPreparingEnemy(null);
          commitEnemies([...enemiesRef.current, prepared.enemy], now);
          previousPressure.current = prepared.pressure;
          spawnDue.current = now + performanceAdjustedSpawnDelayMs(
            settings.spawnIntervalMs,
            currentPerformanceMultiplier,
            true,
            previousPressure.current * 100,
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
  }, [beginMeaning, commitEnemies, decideSpawn, reserveSpawn, settings.enemySpeedMultiplier, settings.spawnIntervalMs, strokeLeadForWord, updateWord, words]);

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
        previousPressure.current * 100,
      );
    }
  }, [settings.spawnIntervalMs]);
  const replay = () => { if (targetWord) playWordAudio(targetWord); };
  /** Unresolved committed work at render time (see `pendingReviewWork`).
   * The refs it reads only change inside reserveSpawn/updateWord, both of
   * which also setState — so every render observing them is fresh. */
  const pendingWork = (() => {
    const inFlightKeys = new Set(enemies.map((enemy) => enemy.wordId));
    if (preparingEnemy) inFlightKeys.add(preparingEnemy.wordId);
    return pendingReviewWork(reviewSessionRef.current, options.plan.spawns.length, inFlightKeys);
  })();
  return {
    enemies, preparingEnemy, target, targetWord, phase, pinyinAutocompleted, choices, feedback, learningPaused,
    audioError, streak, performanceMultiplier, stats, sessionComplete, pendingWork, submitPinyin, chooseMeaning,
    dismissFeedback, replay,
  };
}
