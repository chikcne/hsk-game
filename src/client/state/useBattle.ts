import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_TRAVEL_MS, DANGER_ZONE_PROGRESS, MAX_ACTIVE_ENEMIES, type ChoiceKey,
} from "../../shared/constants";
import type { BattleConfig, VocabRow } from "../../shared/battle";
import type { DifficultySettings, ReviewInputMode, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin } from "../../domain/deck/pinyin";
import { applyMasteryOutcome, battlePools, masteryCategory, selectBattleSpawn } from "../../domain/battle";
import { createSecureRandomState, Xoshiro128StarStar } from "../../domain/random";
import { safeMeaningChoices, type MeaningChoice } from "../../domain/session/choices";
import { buildPinyinLabelPool, generatePinyinChoices } from "../../domain/session/pinyin-choices";
import { applyPinyinSelection, initialPinyinSelection, type PinyinSelectionProgress } from "../../domain/session/pinyin-selection";
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
   * answer then succeeded: a miss — never presented as a clean DIRECT HIT,
   * scoring no points, resetting the streak, and costing mastery. */
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
};
export type SessionStats = {
  mode: "battle";
  score: number;
  correct: number;
  wrongPinyin: number;
  wrongMeaning: number;
  landed: number;
  bestStreak: number;
  /** Unique word keys served (a word can serve multiple times). */
  seen: Set<string>;
  wordStats: Map<string, WordSessionStats>;
  /** Every resolved enemy. The battle is endless: there is no target length,
   * and progress is tracked per resolved spawn, not per unique word. */
  resolvedSpawns: number;
};

/** Authoritative server rows for one resolved encounter. `null` from a
 * failed POST leaves the optimistic in-memory mastery standing. */
export type OutcomePersistenceResult = {
  row: VocabRow;
  addedRows: VocabRow[];
} | null;

/** Distractor word pools feeding Selection Mode's pinyin choices. */
export type RuntimeWordPool = {
  /** Words in the launch-time battle pool (close distractor source). */
  poolWords: readonly RuntimeWord[];
  /** Loaded deck words outside the vocabulary at launch. */
  outsideWords: readonly RuntimeWord[];
};

export type BattleOptions = {
  /** Merged cross-grade corpus deck; word IDs are curriculum card IDs. */
  deck: RuntimeDeck;
  /** Vocab rows from POST /battle/open (the server already seeded 1..5 on a
   * fresh save). Live selection draws every spawn from this snapshot. */
  initialVocab: readonly VocabRow[];
  battleConfig: BattleConfig;
  /** Pinyin-selection distractor sources (Selection Mode only). */
  pinyinPoolWords: RuntimeWordPool;
  /** Deterministic draw stream for tests; seeded securely when omitted. */
  rngState?: [number, number, number, number];
  /** Persists one resolved encounter asynchronously. The hook merges the
   * returned authoritative/added rows back into its in-memory vocab without
   * blocking the animation. */
  persistOutcome: (cardId: string, cleanCorrect: boolean) => Promise<OutcomePersistenceResult>;
  /** Notified after every vocab mutation (optimistic or authoritative). */
  onVocabChange?: (vocab: readonly VocabRow[]) => void;
};

/** Selection-mode view of the locked target's pinyin progress. */
export type PinyinSelectionView = {
  labels: string[];
  correct: string;
  selected: string[];
  charIndex: number;
  charCount: number;
  /** The word's Han characters, for the visual progress indicator. */
  hanziChars: string[];
  /** The Han character currently being answered. */
  hanzi: string;
};

/** Vocab-wide mastery category counts for the HUD's category meter. */
export type MasteryCounts = { low: number; developing: number; mastered: number };

const initialStats = (): SessionStats => ({
  mode: "battle", score: 0, correct: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0,
  bestStreak: 0, seen: new Set(), wordStats: new Map(), resolvedSpawns: 0,
});

const countMastery = (vocab: readonly VocabRow[], config: BattleConfig): MasteryCounts => {
  const counts: MasteryCounts = { low: 0, developing: 0, mastered: 0 };
  for (const row of vocab) counts[masteryCategory(row.mastery, config)] += 1;
  return counts;
};

/** Inserts/replaces rows by cardId, keeping global id (curriculum position)
 * order — the ordering every pool computation relies on. */
function mergeVocabRows(current: readonly VocabRow[], incoming: readonly VocabRow[]): VocabRow[] {
  if (incoming.length === 0) return [...current];
  const byCard = new Map(current.map((row) => [row.cardId, row]));
  for (const row of incoming) byCard.set(row.cardId, row);
  return [...byCard.values()].sort((left, right) => left.id - right.id);
}

type PreparedSpawn = {
  enemy: Enemy;
  /** Mastery/100 pressure of the spawned word (spawn-delay adjustment). */
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
  inputModeSetting: ReviewInputMode,
) {
  const { deck, battleConfig } = options;
  const words = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const wordAudioPlayer = useMemo(() => new WordAudioPlayer(), [deck.fingerprint]);

  /** Effective pinyin answer style for the CURRENT orientation/settings. The
   * input mode is locked per enemy (`lockedInputModeRef`): orientation flips
   * and mid-battle settings changes only take effect on the NEXT target, so
   * an in-progress answer is never erased. */
  const inputModeSettingRef = useRef(inputModeSetting);
  inputModeSettingRef.current = inputModeSetting;
  const lockedInputModeRef = useRef<ReviewInputMode>(inputModeSetting);
  const [inputMode, setInputMode] = useState<ReviewInputMode>(inputModeSetting);
  const [selectionProgress, setSelectionProgress] = useState<PinyinSelectionProgress>(initialPinyinSelection);
  const selectionProgressRef = useRef(selectionProgress);
  selectionProgressRef.current = selectionProgress;

  /** The in-memory vocab snapshot: mutated optimistically on every outcome,
   * then reconciled with the authoritative server rows. Ref-first so the
   * animation frame reads and writes synchronously. */
  const vocabRef = useRef<VocabRow[]>(mergeVocabRows([], options.initialVocab));
  const [vocab, setVocab] = useState<readonly VocabRow[]>(vocabRef.current);
  const [masteryCounts, setMasteryCounts] = useState<MasteryCounts>(() => countMastery(vocabRef.current, battleConfig));
  /** In-memory draw stream — deliberately NOT persisted: a restarted battle
   * simply draws fresh. */
  const rngRef = useRef(new Xoshiro128StarStar(options.rngState ?? createSecureRandomState()));
  const mountedRef = useRef(true);
  const preloadedAudio = useRef(new Set<string>());

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
  const [stats, setStats] = useState<SessionStats>(initialStats);
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
  const spawnOrdinal = useRef(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const optionsRef = useRef(options); optionsRef.current = options;
  const suspendedAt = useRef<number | null>(null);

  const commitVocab = useCallback((next: VocabRow[]) => {
    vocabRef.current = next;
    setVocab(next);
    setMasteryCounts(countMastery(next, battleConfig));
    optionsRef.current.onVocabChange?.(next);
  }, [battleConfig]);

  const preloadCardAudio = useCallback((cardIds: readonly string[]) => {
    const fresh = cardIds.filter((cardId) => !preloadedAudio.current.has(cardId));
    if (fresh.length === 0) return;
    for (const cardId of fresh) preloadedAudio.current.add(cardId);
    // Preload only the vocabulary's audio (the corpus holds ~5,400 files);
    // later refill rows preload as the server appends them.
    wordAudioPlayer.preload(fresh.flatMap((cardId) => {
      const word = words.get(cardId);
      const source = word ? wordAudioSource(deck.id, word) : "";
      return source ? [source] : [];
    }));
  }, [deck.id, wordAudioPlayer, words]);

  useEffect(() => {
    mountedRef.current = true;
    preloadCardAudio(vocabRef.current.map((row) => row.cardId));
    return () => { mountedRef.current = false; };
  }, [preloadCardAudio]);

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
      // A new locked target re-locks the input mode from the CURRENT
      // orientation/settings and restarts selection progress from scratch.
      lockedInputModeRef.current = inputModeSettingRef.current;
      setInputMode(inputModeSettingRef.current);
      const initialSelection = initialPinyinSelection();
      selectionProgressRef.current = initialSelection;
      setSelectionProgress(initialSelection);
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
  ) => {
    const credit = encounterCredit(outcome, autocompleted);
    const nowStreak = nextStreak(streakRef.current, credit.streakContinues, false);
    setStreak(nowStreak);
    setStats((old) => {
      const seen = new Set(old.seen).add(word.id);
      const wordStats = new Map(old.wordStats);
      const previous = wordStats.get(word.id) ?? {
        attempts: 0, misses: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, autocompleted: 0,
        totalPinyinMs: 0,
      };
      wordStats.set(word.id, {
        attempts: previous.attempts + 1,
        misses: previous.misses + (missed ? 1 : 0),
        wrongPinyin: previous.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0),
        wrongMeaning: previous.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0),
        landed: previous.landed + (outcome.kind === "landed" ? 1 : 0),
        autocompleted: previous.autocompleted + (autocompleted ? 1 : 0),
        totalPinyinMs: previous.totalPinyinMs + pinyinMs,
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
   * Picks the next spawn LIVE: category weights over the current pools,
   * uniform within the selected category, and never a word that is already
   * active or preparing. Returns null when every pool member is currently
   * on the field — waiting is safe because every enemy resolves in finite
   * time. There is no plan, no cursor, and no completion condition: the
   * battle runs until the player ends it.
   */
  const decideSpawn = useCallback(() => {
    const activeKeys = new Set(enemiesRef.current.map((enemy) => enemy.wordId));
    if (preparingRef.current) activeKeys.add(preparingRef.current.enemy.wordId);
    return selectBattleSpawn(vocabRef.current, battleConfig, rngRef.current, activeKeys);
  }, [battleConfig]);

  /** Reserves a decided spawn: builds the enemy keyed by the vocab card id.
   * The mastery snapshot at spawn time is the encounter's pressure input. */
  const reserveSpawn = useCallback((selection: NonNullable<ReturnType<typeof decideSpawn>>): PreparedSpawn | null => {
    const word = words.get(selection.row.cardId);
    if (!word) return null;
    const ordinal = spawnOrdinal.current++;
    const pressure = selection.row.mastery / 100;
    const enemy: Enemy = {
      id: `e-${Date.now()}-${enemySequence.current++}`,
      wordId: selection.row.cardId,
      progress: 0,
      speedMultiplier: wordSpeedMultiplierForFamiliarity(pressure),
      isNewWord: selection.row.mastery === 0,
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
    // Clean correct is EXACTLY the encounterCredit semantics: a correct
    // outcome with no autocomplete reveal. It is the only mastery-earning
    // resolution; wrong pinyin, wrong meaning, a landing, and a reveal (even
    // when the meaning answer then succeeds) all cost mastery.
    const cleanCorrect = encounterCredit(outcome, wasRevealed).countsAsCorrect;
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

    // Optimistic mastery update keeps live weights and pressure honest; the
    // server's authoritative row replaces it when the POST resolves.
    const rowIndex = vocabRef.current.findIndex((row) => row.cardId === word.id);
    if (rowIndex >= 0) {
      const current = vocabRef.current[rowIndex]!;
      commitVocab(mergeVocabRows(vocabRef.current, [{
        ...current,
        mastery: applyMasteryOutcome(current.mastery, cleanCorrect, battleConfig),
      }]));
    }
    void optionsRef.current.persistOutcome(word.id, cleanCorrect).then((result) => {
      if (!mountedRef.current || !result) return;
      commitVocab(mergeVocabRows(vocabRef.current, [result.row, ...result.addedRows]));
      preloadCardAudio(result.addedRows.map((row) => row.cardId));
    }).catch(() => {
      // Persistence failed (offline/rejected): the optimistic value stands;
      // the caller surfaces save status from its own persistOutcome wrapper.
    });

    updateSessionStats(word, outcome, pinyinMs, points, !cleanCorrect, wasRevealed);

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
  }, [battleConfig, commitVocab, playWordAudio, preloadCardAudio, settings, updateSessionStats, words]);

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
          const selection = decideSpawn();
          if (selection) {
            const fullLeadMs = strokeLeadForWord(selection.row.cardId);
            if (now >= spawnDue.current - fullLeadMs) {
              const reserved = reserveSpawn(selection);
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
  /** Selection Mode click on one pinyin button. Correct clicks advance (the
   * final one enters the meaning phase through the SAME clean path as a
   * correctly typed pinyin); a wrong click resolves wrongPinyin immediately,
   * carrying the selected sequence plus the wrong label. */
  const choosePinyin = (label: string) => {
    const enemy = targetRef.current;
    const word = enemy ? words.get(enemy.wordId) : null;
    if (!enemy || !word || lockedInputModeRef.current !== "selection") return;
    if (phase !== "pinyin" || pausedRef.current || learningPausedRef.current) return;
    const elapsed = performance.now() - phaseStarted.current;
    const step = applyPinyinSelection(word.pinyinSegments, selectionProgressRef.current, label);
    if (step.kind === "wrong") {
      resolveEnemy(enemy, { kind: "wrongPinyin", pinyinMs: elapsed }, step.attempted);
      return;
    }
    selectionProgressRef.current = step.progress;
    setSelectionProgress(step.progress);
    if (step.kind === "complete") beginMeaning(enemy, word, elapsed);
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
  /** Deterministic per-character choices for the locked target. Keyed by the
   * stable ids (not the per-frame enemy objects) so advancing enemies never
   * regenerate labels mid-answer; enemy id + character index seed the shuffle
   * so every character of every enemy draws fresh positions. */
  // Pool construction walks the full corpus, so cache it outside the
  // animation-driven render path. Only the much smaller pool-member list
  // changes when the locked target changes (to exclude that entire word).
  const outsidePinyinPool = useMemo(
    () => buildPinyinLabelPool(options.pinyinPoolWords.outsideWords),
    [options.pinyinPoolWords.outsideWords],
  );
  const targetWordId = target?.wordId;
  const poolPinyinPool = useMemo(
    () => buildPinyinLabelPool(options.pinyinPoolWords.poolWords, targetWordId),
    [options.pinyinPoolWords.poolWords, targetWordId],
  );
  const selection: PinyinSelectionView | null = useMemo(() => {
    if (!target || phase !== "pinyin" || inputMode !== "selection") return null;
    const word = words.get(target.wordId);
    if (!word || selectionProgress.charIndex >= word.pinyinSegments.length) return null;
    const pools = {
      planPool: poolPinyinPool,
      outsidePool: outsidePinyinPool,
    };
    const { labels, correct } = generatePinyinChoices(word, selectionProgress.charIndex, pools, `${target.id}:${selectionProgress.charIndex}`);
    const hanziChars = [...word.displayHanzi];
    return {
      labels, correct,
      selected: selectionProgress.selected,
      charIndex: selectionProgress.charIndex,
      charCount: word.pinyinSegments.length,
      hanziChars,
      hanzi: hanziChars[selectionProgress.charIndex] ?? word.displayHanzi,
    };
  }, [inputMode, outsidePinyinPool, phase, poolPinyinPool, selectionProgress, target?.id, targetWordId, words]);
  return {
    enemies, preparingEnemy, target, targetWord, phase, pinyinAutocompleted, choices, feedback, learningPaused,
    audioError, streak, performanceMultiplier, stats, vocab, masteryCounts, submitPinyin, chooseMeaning,
    dismissFeedback, replay, inputMode, selection, choosePinyin,
  };
}
