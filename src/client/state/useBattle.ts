import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BASE_TRAVEL_MS, MAX_ACTIVE_ENEMIES, type ChoiceKey } from "../../shared/constants";
import type { DifficultySettings, LevelProgress, RuntimeDeck, RuntimeWord } from "../../shared/schemas";
import { acceptsPinyin } from "../../domain/deck/pinyin";
import { applyOutcomeToLevel, createLevelProgress, spawnNextWord } from "../../domain/learning";
import { randomStateFromSeed } from "../../domain/random";
import { generateChoices, type MeaningChoice } from "../../domain/session/choices";
import { calculatePoints } from "../../domain/session/scoring";
import { nearestEnemy } from "../../domain/session/targeting";
import type { Enemy, EncounterOutcome } from "../../domain/session/types";
import { playSoundEffect } from "../audio/soundEffects";

export type Feedback = { id: string; kind: "correct" | "miss" | "landed"; word: RuntimeWord; typed?: string; points?: number; oldWeight: number; newWeight: number };
export type SessionStats = { score: number; correct: number; wrongPinyin: number; wrongMeaning: number; landed: number; bestStreak: number; seen: Set<string>; newlyMastered: Set<string> };
export const createLevel = (deck: RuntimeDeck): LevelProgress => createLevelProgress(deck, {
  schedulerRng: randomStateFromSeed(`schedule:${deck.fingerprint}`),
  curriculumSeed: `curriculum:${deck.fingerprint}`,
});

export function useBattle(deck: RuntimeDeck, initialLevel: LevelProgress | undefined, settings: DifficultySettings, paused: boolean, onLevelChange: (level: LevelProgress, outcome?: EncounterOutcome, points?: number) => void) {
  const words = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const [level, setLevel] = useState<LevelProgress>(() => initialLevel?.deckFingerprint === deck.fingerprint ? initialLevel : createLevel(deck));
  const levelRef = useRef(level); levelRef.current = level;
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const enemiesRef = useRef(enemies); enemiesRef.current = enemies;
  const [phase, setPhase] = useState<"pinyin" | "meaning">("pinyin");
  const [choices, setChoices] = useState<MeaningChoice[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [learningPaused, setLearningPaused] = useState(false);
  const learningPausedRef = useRef(false); learningPausedRef.current = learningPaused;
  const [audioError, setAudioError] = useState(false);
  const [streak, setStreak] = useState(0);
  const streakRef = useRef(0); streakRef.current = streak;
  const [stats, setStats] = useState<SessionStats>({ score: 0, correct: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, seen: new Set(), newlyMastered: new Set() });
  const target = nearestEnemy(enemies);
  const targetRef = useRef(target); targetRef.current = target;
  const targetWord = target ? words.get(target.wordId) ?? null : null;
  const phaseStarted = useRef(performance.now());
  const meaningPinyinMs = useRef(0);
  const spawnDue = useRef(0);
  const lastFrame = useRef<number | null>(null);
  const enemySequence = useRef(0);
  const pausedRef = useRef(paused); pausedRef.current = paused;

  useEffect(() => { setPhase("pinyin"); setChoices([]); setAudioError(false); phaseStarted.current = performance.now(); }, [target?.id]);

  const updateWord = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    const word = words.get(enemy.wordId); if (!word) return;
    const currentLevel = levelRef.current; const previous = currentLevel.words[word.id];
    if (!previous) return;
    const result = applyOutcomeToLevel(currentLevel, deck, word.id, outcome, new Date());
    const nextLevel = result.level; const weight = result.progress.appearanceWeight;
    const thinking = outcome.kind === "correct" || outcome.kind === "wrongMeaning" ? outcome.pinyinMs + outcome.meaningMs : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
    levelRef.current = nextLevel; setLevel(nextLevel);
    const nowStreak = outcome.kind === "correct" ? streakRef.current + 1 : 0;
    setStreak(nowStreak);
    const points = outcome.kind === "correct" ? calculatePoints(thinking, streakRef.current, settings.spawnIntervalMs, settings.enemySpeedMultiplier) : 0;
    setStats((old) => { const seen = new Set(old.seen).add(word.id); const newlyMastered = new Set(old.newlyMastered); if (previous.appearanceWeight > 1 && weight === 1) newlyMastered.add(word.id); return { ...old, score: old.score + points, correct: old.correct + (outcome.kind === "correct" ? 1 : 0), wrongPinyin: old.wrongPinyin + (outcome.kind === "wrongPinyin" ? 1 : 0), wrongMeaning: old.wrongMeaning + (outcome.kind === "wrongMeaning" ? 1 : 0), landed: old.landed + (outcome.kind === "landed" ? 1 : 0), bestStreak: Math.max(old.bestStreak, nowStreak), seen, newlyMastered }; });
    const feedbackKind = outcome.kind === "correct" ? "correct" : outcome.kind === "landed" ? "landed" : "miss";
    playSoundEffect(feedbackKind === "correct" ? "blaster" : "buzzer", settings.masterVolume);
    setFeedback({ id: enemy.id, kind: feedbackKind, word, typed, points, oldWeight: previous.appearanceWeight, newWeight: weight });
    if (feedbackKind === "miss") {
      learningPausedRef.current = true;
      setLearningPaused(true);
    } else {
      window.setTimeout(() => setFeedback((item) => item?.id === enemy.id ? null : item), 1100);
    }
    onLevelChange(nextLevel, outcome, points);
  }, [deck.words, onLevelChange, settings, words]);

  const resolveEnemy = useCallback((enemy: Enemy, outcome: EncounterOutcome, typed?: string) => {
    if (!enemiesRef.current.some((item) => item.id === enemy.id)) return;
    const remaining = enemiesRef.current.filter((item) => item.id !== enemy.id);
    enemiesRef.current = remaining; setEnemies(remaining);
    updateWord(enemy, outcome, typed);
  }, [updateWord]);

  const spawn = useCallback(() => {
    const current = levelRef.current; if (enemiesRef.current.length >= MAX_ACTIVE_ENEMIES) return;
    const result = spawnNextWord(current, deck); if (result.status !== "spawned") return;
    const nextLevel = result.level; const ordinal = result.spawnOrdinal;
    levelRef.current = nextLevel; setLevel(nextLevel); onLevelChange(nextLevel);
    const lane = (ordinal * 5 + 1) % 8; const enemy: Enemy = { id: `e-${Date.now()}-${enemySequence.current++}`, wordId: result.wordId, progress: 0, lane, spawnOrdinal: ordinal, status: "descending" };
    const nextEnemies = [...enemiesRef.current, enemy]; enemiesRef.current = nextEnemies; setEnemies(nextEnemies);
  }, [deck.words, onLevelChange]);

  useEffect(() => { spawnDue.current = performance.now(); }, [settings.spawnIntervalMs]);
  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      if (lastFrame.current === null) lastFrame.current = now;
      const delta = Math.min(100, now - lastFrame.current); lastFrame.current = now;
      if (!pausedRef.current && !learningPausedRef.current && !document.hidden) {
        if (now >= spawnDue.current) { spawn(); spawnDue.current = now + settings.spawnIntervalMs; }
        const advance = delta / BASE_TRAVEL_MS * settings.enemySpeedMultiplier;
        const advanced = enemiesRef.current.map((enemy) => ({ ...enemy, progress: enemy.progress + advance }));
        const landed = advanced.filter((enemy) => enemy.progress >= 1);
        const descending = advanced.filter((enemy) => enemy.progress < 1);
        enemiesRef.current = descending; setEnemies(descending);
        for (const enemy of landed) updateWord(enemy, { kind: "landed", activeThinkingMs: enemy.id === targetRef.current?.id ? Math.max(0, now - phaseStarted.current) : null });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [settings.enemySpeedMultiplier, settings.spawnIntervalMs, spawn, updateWord]);

  const playWordAudio = (word: RuntimeWord) => {
    if (!word.audioUrl) return;
    const source = word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deck.id}/${word.audioUrl}`;
    const audio = new Audio(source); audio.volume = settings.masterVolume; void audio.play().catch(() => setAudioError(true));
  };
  const submitPinyin = (raw: string) => {
    const enemy = targetRef.current; const word = enemy ? words.get(enemy.wordId) : null; if (!enemy || !word || !raw.trim() || phase !== "pinyin" || pausedRef.current || learningPausedRef.current) return;
    const elapsed = performance.now() - phaseStarted.current;
    if (acceptsPinyin(word.acceptedPinyin, raw)) { meaningPinyinMs.current = elapsed; setChoices(generateChoices(deck, word, enemy.id)); setPhase("meaning"); phaseStarted.current = performance.now(); playWordAudio(word); }
    else resolveEnemy(enemy, { kind: "wrongPinyin", pinyinMs: elapsed }, raw);
  };
  const chooseMeaning = (key: ChoiceKey) => {
    const enemy = targetRef.current; if (!enemy || phase !== "meaning" || pausedRef.current || learningPausedRef.current) return; const choice = choices.find((item) => item.key === key); if (!choice) return;
    const meaningMs = performance.now() - phaseStarted.current;
    resolveEnemy(enemy, choice.correct ? { kind: "correct", pinyinMs: meaningPinyinMs.current, meaningMs } : { kind: "wrongMeaning", pinyinMs: meaningPinyinMs.current, meaningMs });
  };
  const dismissFeedback = useCallback(() => {
    if (!learningPausedRef.current) return;
    learningPausedRef.current = false;
    setLearningPaused(false);
    setFeedback((item) => item?.kind === "miss" ? null : item);
    const now = performance.now();
    phaseStarted.current = now;
    lastFrame.current = now;
    spawnDue.current = now + settings.spawnIntervalMs;
  }, [settings.spawnIntervalMs]);
  const replay = () => { if (targetWord) playWordAudio(targetWord); };
  return { enemies, target, targetWord, phase, choices, feedback, learningPaused, audioError, streak, stats, level, submitPinyin, chooseMeaning, dismissFeedback, replay };
}
