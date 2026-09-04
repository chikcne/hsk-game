import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CHOICE_KEYS, DECK_IDS, DECK_TOTALS, DEFAULT_SETTINGS, REVIEW_MIN_ACQUIRED_WORDS, type ChoiceKey, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema, type DifficultySettings, type LevelProgress, type RuntimeDeck, type SaveFile } from "../../shared/schemas";
import { applyLearnRating, nextLearnDueAtMs, prepareLearnLaunch, type LearnRating, type LearnRatingApplication } from "../../domain/learn";
import { applyRelearnRating, createRelearnSession, type RelearnRatingApplication } from "../../domain/relearn";
import { buildReviewPlanFromSnapshot, reviewWordIdOf, type ReviewPlan } from "../../domain/review";
import { countGraduated, curriculumLessonNumber, reconcileLevelProgress } from "../../domain/learning";
import type { EncounterOutcome } from "../../domain/session/types";
import { createSecureRandomState } from "../../domain/random";
import { createDemoDeck } from "../data/demoDeck";
import { createReviewDeck } from "../data/reviewDeck";
import { loadStrokeBundle, loadStrokeBundles, loadUiStrokeBundle, mergeStrokeData, type StrokeDataMap } from "../data/strokeData";
import { loadSave, putSave } from "../api/saves";
import { GameCanvas } from "../game/GameCanvas";
import { HanziText } from "../game/HanziText";
import { useBattle, type ReviewProgressReport, type SessionStats, type BattleOptions } from "../state/useBattle";
import { LearnScreen } from "./LearnScreen";
import { RelearnScreen } from "./RelearnScreen";
import { unlockSoundEffects } from "../audio/soundEffects";

const deckLabel = (id: DeckId) => `HSK ${id.at(-1)}`;
const masteredCount = (level?: LevelProgress) => level ? countGraduated(level) : 0;
const gradeActionLabel = (level?: LevelProgress) => level && level.curriculumCursor > 0 ? "CONTINUE" : "START";
const LEVEL_HANZI = ["一", "二", "三", "四", "五", "六"] as const;
const LEVEL_DESCRIPTIONS = ["基础词卷", "日常词卷", "进阶词卷", "长篇词卷", "高阶词卷", "通达词卷"] as const;
const statusLabel = (status: string) => status === "saved" ? "PROGRESS SAVED" : status === "saving" ? "SAVING PROGRESS" : status === "offline" ? "SAVED OFFLINE" : "SAVE ERROR";
const HAN_CHARACTER = /^\p{Script=Han}$/u;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useMobileLayout() {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 599px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 599px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

async function loadRuntimeDeck(id: DeckId, allowDemoFallback = true): Promise<RuntimeDeck> {
  try {
    const response = await fetch(`/game-data/${id}/deck.json`);
    if (!response.ok) throw new Error("Generated deck not found");
    return RuntimeDeckSchema.parse(await response.json());
  } catch (error) {
    // Never reconcile persisted progress against a transient demo deck: doing
    // so can orphan the real vocabulary and create unresolvable review cards.
    if (!allowDemoFallback) throw error;
    return createDemoDeck(id);
  }
}

function updateLifetime(save: SaveFile, outcome: EncounterOutcome, points: number): SaveFile["lifetime"] {
  const lifetime = { ...save.lifetime };
  lifetime.resolvedEnemies += 1;
  lifetime.score += points;
  lifetime.totalThinkingMs += outcome.kind === "correct" || outcome.kind === "wrongMeaning"
    ? outcome.pinyinMs + outcome.meaningMs
    : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
  if (outcome.kind === "correct") lifetime.completeCorrect += 1;
  else lifetime[outcome.kind] += 1;
  return lifetime;
}

/** Per-profile curriculum seed so two players never share an introduction
 * order (the seeded fallback only exists for deterministic tests). */
function secureCurriculumSeed(): string {
  return createSecureRandomState().map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function App() {
  const [screen, setScreen] = useState<"decks" | "loading" | "learn" | "relearn" | "battle" | "summary">("loading");
  const [save, setSave] = useState<SaveFile | null>(null);
  const saveRef = useRef<SaveFile | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "offline" | "error">("saving");
  const pendingSave = useRef<SaveFile | null>(null);
  const writing = useRef(false);
  const [deck, setDeck] = useState<RuntimeDeck | null>(null);
  const [uiStrokeData, setUiStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [strokeData, setStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [selected, setSelected] = useState<DeckId>("hsk-1");
  const [menu, setMenu] = useState<"main" | "grades">("main");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<SessionStats | null>(null);
  const [reviewPlan, setReviewPlan] = useState<ReviewPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const uiStrokes = loadUiStrokeBundle().then((loaded) => {
      setUiStrokeData(loaded);
      return loaded;
    });
    void Promise.all([loadSave(), uiStrokes]).then(([{ save: loaded, online }]) => {
      saveRef.current = loaded;
      setSave(loaded);
      setSaveStatus(online ? "saved" : "offline");
      setScreen("decks");
    });
  }, []);
  useEffect(() => {
    const pagehide = () => {
      const current = saveRef.current; if (!current) return;
      const snapshot = { ...current } as Record<string, unknown>;
      delete snapshot.revision; delete snapshot.savedAt;
      navigator.sendBeacon?.("/api/saves/default/beacon", JSON.stringify({ expectedRevision: current.revision, snapshot }));
    };
    window.addEventListener("pagehide", pagehide);
    return () => window.removeEventListener("pagehide", pagehide);
  }, []);

  const drainSaves = useCallback(async () => {
    if (writing.current) return;
    writing.current = true;
    while (pendingSave.current) {
      const payload = pendingSave.current;
      pendingSave.current = null;
      setSaveStatus("saving");
      try {
        const authoritative = await putSave(payload);
        const queuedAfterWrite = pendingSave.current as SaveFile | null;
        if (queuedAfterWrite) pendingSave.current = { ...queuedAfterWrite, revision: authoritative.revision, savedAt: authoritative.savedAt };
        else { saveRef.current = authoritative; setSave(authoritative); }
        setSaveStatus("saved");
      } catch {
        setSaveStatus(navigator.onLine ? "error" : "offline");
        break;
      }
    }
    writing.current = false;
  }, []);

  const queueSnapshot = useCallback((snapshot: SaveFile) => {
    saveRef.current = snapshot;
    setSave(snapshot);
    pendingSave.current = snapshot;
    void drainSaves();
  }, []);

  /** Applies one explicit Learn rating through the pure domain step and the
   * atomic save queue; returns the application so LearnScreen can advance. */
  const rateLearn = useCallback((deckId: DeckId, wordId: string, rating: LearnRating): LearnRatingApplication | null => {
    const current = saveRef.current; if (!current) return null;
    const applied = applyLearnRating(current, deckId, wordId, rating, new Date());
    queueSnapshot(applied.save);
    return applied;
  }, [queueSnapshot]);

  /** Grade clicks launch Learn Mode — never the arcade. An active session for
   * the grade is resumed exactly; otherwise one is created from every due
   * introduced word plus up to `levelSize` new curriculum words. The pure
   * `prepareLearnLaunch` step produces BOTH the level record (with the new
   * words' introductions and the advanced curriculum cursor) and the session,
   * and this caller persists them together in one atomic snapshot. */
  const deployLearn = async (id: DeckId) => {
    unlockSoundEffects();
    setLoadError(null);
    setSelected(id);
    setScreen("loading");
    const current = saveRef.current;
    if (!current) { setScreen("decks"); return; }
    try {
      const hasProgress = current.levels[id] !== undefined;
      const [loadedDeck, loadedStrokes] = await Promise.all([loadRuntimeDeck(id, !hasProgress), loadStrokeBundle(id)]);
      const launch = prepareLearnLaunch(current, loadedDeck, new Date(), {
        levelSize: current.settings.levelSize,
        newLevelSeed: secureCurriculumSeed(),
      });
      const { levels, session } = launch;
      if (launch.changed) {
        queueSnapshot({
          ...current,
          levels,
          learnSessions: { ...current.learnSessions, [id]: session },
        });
      }
      setDeck(loadedDeck); setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setPaused(false); setScreen("learn");
    } catch (error) {
      setDeck(null);
      const caughtUp = error instanceof RangeError;
      const level = saveRef.current?.levels[id];
      const nextDueMs = level ? nextLearnDueAtMs(level, new Date()) : null;
      const nextDue = caughtUp && nextDueMs !== null
        ? ` Next card is due at ${new Date(nextDueMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
        : "";
      setLoadError(caughtUp
        ? `${deckLabel(id)} is all caught up — nothing is due and no new words remain.${nextDue}`
        : `Could not load ${deckLabel(id)} data. Your saved progress was not changed.`);
      setScreen("decks");
    }
  };

  /** Review Mode battles draw ONLY from `acquired_words` (the recency log).
   * The deterministic base plan is built at session start from the persisted
   * RNG and is never persisted itself — only its advanced scheduler snapshot
   * is checkpointed, so a restarted session differs deterministically. The
   * session is not resumable. */
  const deployReview = async () => {
    const current = saveRef.current;
    if (!current || current.acquiredWords.length < REVIEW_MIN_ACQUIRED_WORDS) return;
    unlockSoundEffects();
    setLoadError(null);
    setScreen("loading");
    try {
      const [loaded, loadedStrokes] = await Promise.all([
        Promise.all(DECK_IDS.map(async (id) => [id, await loadRuntimeDeck(id, current.levels[id] === undefined)] as const)),
        loadStrokeBundles(DECK_IDS),
      ]);
      const loadedDecks = new Map(loaded);
      let levels = current.levels;
      let learnSessions = current.learnSessions;
      for (const [id, loadedDeck] of loaded) {
        const existing = levels[id];
        if (!existing || existing.deckFingerprint === loadedDeck.fingerprint) continue;
        const reconciled = reconcileLevelProgress(existing, loadedDeck, current.spawnOrdinal).level;
        levels = { ...levels, [id]: reconciled };
        // A deck update invalidates the grade's persisted active session (its
        // fingerprint no longer matches): drop it in the SAME snapshot, or the
        // server would (rightly) reject the fingerprint mismatch forever.
        if (learnSessions[id]) learnSessions = { ...learnSessions, [id]: null };
      }
      const reviewDeck = createReviewDeck(loadedDecks, current.acquiredWords);
      const presentable = new Set(reviewDeck.deck.words.map((word) => word.id));
      const plan = buildReviewPlanFromSnapshot(
        current.acquiredWords.filter((key) => presentable.has(key)),
        current.settings.reviewSessionLength,
        { spawnOrdinal: current.spawnOrdinal, schedulerRng: current.schedulerRng },
      );
      if (plan.spawns.length === 0) {
        setLoadError(`Review needs at least ${REVIEW_MIN_ACQUIRED_WORDS} available acquired words.`);
        setScreen("decks");
        return;
      }
      // Checkpoint reconciled levels (+ invalidated stale sessions) and the
      // plan-consumed RNG in one atomic snapshot, so even an immediately
      // abandoned session never replays an identical battle.
      queueSnapshot({
        ...current,
        levels,
        learnSessions,
        spawnOrdinal: plan.snapshot.spawnOrdinal,
        schedulerRng: plan.snapshot.schedulerRng,
      });
      setDeck(reviewDeck.deck); setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setReviewPlan(plan);
      setPaused(false); setScreen("battle");
    } catch {
      setDeck(null);
      setLoadError("Could not load all saved grade data. Review was not started and progress was not changed.");
      setScreen("decks");
    }
  };

  /** Re-learning resumes THE one cross-grade active session; exiting
   * preserves it, so the title-screen column is the dedicated resume entry. */
  const deployRelearn = async () => {
    const current = saveRef.current;
    const session = current?.relearnSession ?? null;
    if (!current || !session) return;
    unlockSoundEffects();
    setLoadError(null);
    setScreen("loading");
    try {
      const [loaded, loadedStrokes] = await Promise.all([
        Promise.all(DECK_IDS.map(async (id) => [id, await loadRuntimeDeck(id, current.levels[id] === undefined)] as const)),
        loadStrokeBundles(DECK_IDS),
      ]);
      const loadedDecks = new Map(loaded);
      const mergedDeck = createReviewDeck(loadedDecks, session.wordKeys, { title: "Relearn" });
      const presentable = new Set(mergedDeck.deck.words.map((word) => word.id));
      // Defensive: a deck update can remove a selected word entirely. Drop
      // such members (their stroke data no longer exists) before resuming.
      const missing = session.wordKeys.filter((key) => !presentable.has(key));
      let workingSession = session;
      if (missing.length > 0) {
        const cards = { ...session.cards };
        for (const key of missing) delete cards[key];
        workingSession = {
          ...session,
          wordKeys: session.wordKeys.filter((key) => !missing.includes(key)),
          cards,
        };
        queueSnapshot({ ...current, relearnSession: workingSession.wordKeys.length > 0 ? workingSession : null });
      }
      if (workingSession.wordKeys.length === 0) {
        setScreen("decks");
        return;
      }
      setDeck(mergedDeck.deck); setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setPaused(false); setScreen("relearn");
    } catch {
      setDeck(null);
      setLoadError("Could not load the relearn session data. Your saved progress was not changed.");
      setScreen("decks");
    }
  };

  /** Applies one rating to the member's INDEPENDENT relearn card through the
   * pure domain step and the atomic save queue; main Learn cards untouched. */
  const rateRelearn = useCallback((wordKey: string, rating: LearnRating): RelearnRatingApplication | null => {
    const current = saveRef.current; if (!current) return null;
    const applied = applyRelearnRating(current, wordKey, rating, new Date());
    queueSnapshot(applied.save);
    return applied;
  }, [queueSnapshot]);

  /** Starts THE one active relearn session from Review summary selections.
   * Refused while a session is already active — finish (or keep) that one
   * first; the title-screen column resumes it. */
  const startRelearn = (wordKeys: string[]) => {
    const current = saveRef.current;
    if (!current || current.relearnSession || wordKeys.length === 0) return false;
    queueSnapshot({ ...current, relearnSession: createRelearnSession(wordKeys, new Date()) });
    return true;
  };
  const applySettings = (settings: DifficultySettings) => {
    if (!saveRef.current) return;
    queueSnapshot({ ...saveRef.current, settings });
    setSettingsOpen(false);
  };
  const settings = save?.settings ?? { ...DEFAULT_SETTINGS };

  if (!save || screen === "loading") return <LoadingScreen hasSave={Boolean(save)} strokeData={uiStrokeData} />;
  if (screen === "decks") return <>
    {loadError && <p className="deck-load-error" role="alert">{loadError}</p>}
    <DeckSelect save={save} settings={settings} selected={selected} strokeData={uiStrokeData} menu={menu} onMenuChange={setMenu} onSelect={setSelected} onLearn={deployLearn} onReview={() => void deployReview()} onRelearn={() => void deployRelearn()} onSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "learn" && deck) return <>
    <LearnScreen
      save={save} deck={deck} strokeData={strokeData} settings={settings} saveStatus={saveStatus}
      onRate={rateLearn}
      onExit={() => setScreen("decks")}
      onAgain={() => void deployLearn(deck.id)}
      onSettings={() => setSettingsOpen(true)}
    />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "relearn" && deck) return <>
    <RelearnScreen
      save={save} deck={deck} strokeData={strokeData} settings={settings} saveStatus={saveStatus}
      onRate={rateRelearn}
      onExit={() => setScreen("decks")}
      onSettings={() => setSettingsOpen(true)}
    />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "summary" && summary) return <Summary
    stats={summary} deck={deck} strokeData={strokeData} saveStatus={saveStatus}
    relearnBlocked={save.relearnSession !== null}
    onStartRelearn={(keys) => { if (startRelearn(keys)) void deployRelearn(); }}
    onNewReview={() => void deployReview()} onGrades={() => setScreen("decks")}
  />;
  if (!deck || !reviewPlan) return <LoadingScreen hasSave strokeData={uiStrokeData} />;

  return <BattleScreen
    key={`review-${deck.fingerprint}-${screen}`}
    deck={deck}
    strokeData={strokeData}
    plan={reviewPlan}
    snapshot={reviewPlan.snapshot}
    settings={settings}
    paused={paused || settingsOpen}
    saveStatus={saveStatus}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onSettings={() => setSettingsOpen(true)}
    onProgressChange={(report) => {
      const current = saveRef.current; if (!current) return;
      queueSnapshot({
        ...current,
        spawnOrdinal: report.snapshot.spawnOrdinal,
        schedulerRng: report.snapshot.schedulerRng,
        lifetime: report.outcome ? updateLifetime(current, report.outcome, report.points) : current.lifetime,
      });
    }}
    onEnd={(stats) => {
      // lifetime.bestStreak is only knowable at session end: persist the best
      // streak achieved in the finished review battle.
      const current = saveRef.current;
      if (current && stats.bestStreak > current.lifetime.bestStreak) {
        queueSnapshot({ ...current, lifetime: { ...current.lifetime, bestStreak: stats.bestStreak } });
      }
      setSummary(stats); setPaused(false); setSettingsOpen(false); setScreen("summary");
    }}
  >
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </BattleScreen>;
}

function LoadingScreen({ hasSave, strokeData }: { hasSave: boolean; strokeData: StrokeDataMap }) {
  return <main className="loading-screen paper"><div className="loader-logo"><HanziText text="字多多" data={strokeData} /></div><h1>ZIDUODUO</h1><p>{hasSave ? "LOADING GRADE DATA" : "CONNECTING TO SERVER"}</p><div className="loading-bar"><i /></div><small>LOCAL-FIRST • OFFLINE READY</small></main>;
}

/** The title screen has two levels: the main menu offers the four modes, and
 * the grade submenu lists the six HSK volumes with a return column. The menu
 * level lives in App so a failed launch drops the player back where they
 * started (the grades submenu after a grade click, the main menu otherwise). */
function DeckSelect({ save, settings, selected, strokeData, menu, onMenuChange, onSelect, onLearn, onReview, onRelearn, onSettings }: {
  save: SaveFile; settings: DifficultySettings; selected: DeckId; strokeData: StrokeDataMap; menu: "main" | "grades"; onMenuChange: (menu: "main" | "grades") => void; onSelect: (id: DeckId) => void;
  onLearn: (id: DeckId) => void; onReview: () => void; onRelearn: () => void; onSettings: () => void;
}) {
  return <main className={`paper deck-screen ${settings.reducedMotion ? "reduce-motion" : ""}`}>
    <button className="settings-button" onClick={onSettings} aria-label="System settings">
      <img className="mooncake-icon" src="/images/mooncake-settings.png" alt="" />
    </button>
    {menu === "main"
      ? <ModeMenu
          save={save} settings={settings} selected={selected} strokeData={strokeData}
          onSelect={onSelect} onLearn={onLearn} onReview={onReview} onRelearn={onRelearn}
          onOpenGrades={() => onMenuChange("grades")}
        />
      : <GradeMenu
          save={save} selected={selected} strokeData={strokeData} reducedMotion={settings.reducedMotion}
          onSelect={onSelect} onLearn={onLearn} onReturn={() => onMenuChange("main")}
        />}
  </main>;
}

const MODE_COUNT = 4;

function ModeMenu({ save, settings, selected, strokeData, onSelect, onLearn, onReview, onRelearn, onOpenGrades }: {
  save: SaveFile; settings: DifficultySettings; selected: DeckId; strokeData: StrokeDataMap; onSelect: (id: DeckId) => void;
  onLearn: (id: DeckId) => void; onReview: () => void; onRelearn: () => void; onOpenGrades: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const acquiredCount = save.acquiredWords.length;
  const reviewEnabled = acquiredCount >= REVIEW_MIN_ACQUIRED_WORDS;
  const relearnSession = save.relearnSession;
  const relearnEnabled = relearnSession !== null;
  const selectedLevel = save.levels[selected];
  const selectedMastered = masteredCount(selectedLevel);
  const selectedTotal = selectedLevel ? Object.keys(selectedLevel.words).length : DECK_TOTALS[selected];
  const lessonNumber = selectedLevel ? curriculumLessonNumber(selectedLevel, settings.levelSize) : 1;
  const totalMastered = DECK_IDS.reduce((sum, id) => sum + masteredCount(save.levels[id]), 0);
  const totalWords = DECK_IDS.reduce((sum, id) => {
    const level = save.levels[id];
    return sum + (level ? Object.keys(level.words).length : DECK_TOTALS[id]);
  }, 0);

  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(MODE_COUNT - 1, index));
    setActiveIndex(next);
    buttonRefs.current[next]?.focus();
  };

  return <section
    className="scroll-menu mode-menu"
    aria-label="Choose a mode"
    onKeyDown={(event) => {
      const focusedIndex = buttonRefs.current.findIndex((item) => item === document.activeElement);
      const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus((currentIndex + 1) % MODE_COUNT); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus((currentIndex + MODE_COUNT - 1) % MODE_COUNT); }
      else if (event.key === "Home") { event.preventDefault(); moveFocus(0); }
      else if (event.key === "End") { event.preventDefault(); moveFocus(MODE_COUNT - 1); }
    }}
  >
    <button
      ref={(node) => { buttonRefs.current[0] = node; }}
      className={`scroll-column lesson ${activeIndex === 0 ? "selected" : ""}`}
      onFocus={() => setActiveIndex(0)} onMouseEnter={() => setActiveIndex(0)} onClick={() => void onLearn(selected)}
    >
      <span className="column-kicker">LEARN MODE</span><strong><HanziText text="续习" data={strokeData} vertical /></strong>
      <em><HanziText text={`${deckLabel(selected)} · 第${lessonNumber}课`} data={strokeData} vertical /></em>
      <span className="column-progress"><i style={{ height: `${selectedTotal ? selectedMastered / selectedTotal * 100 : 0}%` }} /></span>
      <span className="column-count">{selectedMastered} / {selectedTotal}</span><span className="seal action-seal"><HanziText text={gradeActionLabel(selectedLevel) === "START" ? "开始" : "续习"} data={strokeData} /></span>
    </button>
    <button
      ref={(node) => { buttonRefs.current[1] = node; }}
      className={`scroll-column grades ${activeIndex === 1 ? "selected" : ""}`}
      onFocus={() => setActiveIndex(1)} onMouseEnter={() => setActiveIndex(1)} onClick={onOpenGrades}
      aria-label="Select a grade"
    >
      <span className="column-kicker">SELECT GRADE</span><strong><HanziText text="选级" data={strokeData} vertical /></strong>
      <em><HanziText text="六级词卷" data={strokeData} vertical /></em>
      <span className="column-progress"><i style={{ height: `${totalWords ? totalMastered / totalWords * 100 : 0}%` }} /></span>
      <span className="column-count">{totalMastered} / {totalWords}</span><span className="seal action-seal"><HanziText text="级" data={strokeData} /></span>
    </button>
    <button
      ref={(node) => { buttonRefs.current[2] = node; }}
      className={`scroll-column review ${activeIndex === 2 ? "selected" : ""} ${reviewEnabled ? "" : "is-disabled"}`}
      onFocus={() => setActiveIndex(2)} onMouseEnter={() => setActiveIndex(2)}
      onClick={() => { if (reviewEnabled) void onReview(); }} aria-disabled={!reviewEnabled}
      aria-label={reviewEnabled
        ? `Start review, ${acquiredCount} acquired words`
        : `Review needs at least ${REVIEW_MIN_ACQUIRED_WORDS} acquired words; ${acquiredCount} acquired`}
    >
      <span className="column-kicker">REVIEW MODE</span><strong><HanziText text="温故" data={strokeData} vertical /></strong><em><HanziText text="跨卷复习" data={strokeData} vertical /></em>
      <span className="column-progress"><i style={{ height: reviewEnabled ? "100%" : "0%" }} /></span>
      <span className="column-count"><HanziText text={`${acquiredCount} 已习得`} data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="习" data={strokeData} /></span>
    </button>
    <button
      ref={(node) => { buttonRefs.current[3] = node; }}
      className={`scroll-column relearn ${activeIndex === 3 ? "selected" : ""} ${relearnEnabled ? "" : "is-disabled"}`}
      onFocus={() => setActiveIndex(3)} onMouseEnter={() => setActiveIndex(3)}
      onClick={() => { if (relearnEnabled) void onRelearn(); }}
      aria-disabled={!relearnEnabled}
      aria-label={relearnEnabled
        ? `Resume re-learning, ${relearnSession!.wordKeys.length} words remaining`
        : "Re-learning is idle. Start a session from a review summary."}
    >
      <span className="column-kicker">RE-LEARN MODE</span><strong><HanziText text="重学" data={strokeData} vertical /></strong><em><HanziText text="巩固错词" data={strokeData} vertical /></em>
      <span className="column-progress"><i style={{ height: relearnEnabled ? "100%" : "0%" }} /></span>
      <span className="column-count"><HanziText text={relearnEnabled ? `${relearnSession!.wordKeys.length} 重学中` : "无进行中"} data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="重" data={strokeData} /></span>
    </button>
  </section>;
}

/** Grade submenu: the return column occupies the left slot and the six HSK
 * volumes fill the rest. Digit keys 1–6 jump straight to (and launch from) a
 * grade, exactly as the old single-level menu did. */
const GRADE_COUNT = 7;

function GradeMenu({ save, selected, strokeData, reducedMotion, onSelect, onLearn, onReturn }: {
  save: SaveFile; selected: DeckId; strokeData: StrokeDataMap; reducedMotion: boolean; onSelect: (id: DeckId) => void;
  onLearn: (id: DeckId) => void; onReturn: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(() => DECK_IDS.indexOf(selected) + 1);
  const columnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Ref mirror so the window-level digit listener honors the CURRENT motion
  // preference without re-subscribing on every settings change (the listener
  // closure would otherwise go stale on a reduced-motion toggle).
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const scrollColumnIntoView = (index: number) => {
    columnRefs.current[index]?.scrollIntoView({
      behavior: reducedMotionRef.current ? "auto" : "smooth",
      block: "nearest",
      inline: "center",
    });
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const digit = Number(event.key);
      if (digit < 1 || digit > 6 || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[aria-modal="true"]')) return;
      const id = `hsk-${digit}` as DeckId;
      onSelect(id);
      setActiveIndex(digit);
      columnRefs.current[digit]?.focus();
      scrollColumnIntoView(digit);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onSelect]);

  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(GRADE_COUNT - 1, index));
    setActiveIndex(next);
    if (next >= 1 && next <= 6) onSelect(DECK_IDS[next - 1]!);
    columnRefs.current[next]?.focus();
    scrollColumnIntoView(next);
  };

  return <section
    className="scroll-menu grade-menu"
    aria-label="Choose a grade"
    onKeyDown={(event) => {
      const focusedIndex = columnRefs.current.findIndex((item) => item === document.activeElement);
      const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus((currentIndex + 1) % GRADE_COUNT); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus((currentIndex + GRADE_COUNT - 1) % GRADE_COUNT); }
      else if (event.key === "Home") { event.preventDefault(); moveFocus(0); }
      else if (event.key === "End") { event.preventDefault(); moveFocus(GRADE_COUNT - 1); }
    }}
  >
    <button
      ref={(node) => { columnRefs.current[0] = node; }}
      className={`scroll-column return-column ${activeIndex === 0 ? "selected" : ""}`}
      onFocus={() => setActiveIndex(0)} onMouseEnter={() => setActiveIndex(0)} onClick={onReturn}
      aria-label="Return to the main menu"
    >
      <span className="return-arrow" aria-hidden="true">←</span>
      <strong><HanziText text="返回" data={strokeData} vertical /></strong>
      <em>RETURN</em>
    </button>
    <div className="level-columns">
    {DECK_IDS.map((id, index) => {
      const level = save.levels[id];
      const mastered = masteredCount(level);
      const total = level ? Object.keys(level.words).length : DECK_TOTALS[id];
      const percent = total ? mastered / total * 100 : 0;
      const menuIndex = index + 1;
      return <button
        key={id}
        ref={(node) => { columnRefs.current[menuIndex] = node; }}
        className={`scroll-column level ${activeIndex === menuIndex ? "selected" : ""} ${level?.firstCompletedAt ? "complete" : ""}`}
        onFocus={() => { setActiveIndex(menuIndex); onSelect(id); }}
        onMouseEnter={() => { setActiveIndex(menuIndex); onSelect(id); }}
        onClick={() => void onLearn(id)}
        aria-label={`${deckLabel(id)}, ${mastered} of ${total} words acquired`}
      >
        <span className="column-kicker">HSK 0{index + 1}</span><strong><HanziText text={`${LEVEL_HANZI[index]}级`} data={strokeData} vertical /></strong>
        <em><HanziText text={LEVEL_DESCRIPTIONS[index]!} data={strokeData} vertical /></em><span className="column-progress"><i style={{ height: `${percent}%` }} /></span>
        <span className="column-count">{mastered} / {total}</span>{level?.firstCompletedAt && <span className="seal mini-seal"><HanziText text="成" data={strokeData} /></span>}
        {activeIndex === menuIndex && <span className="selection-brush" aria-hidden="true" />}
      </button>;
    })}
    </div>
  </section>;
}

type BattleProps = {
  deck: RuntimeDeck; strokeData: StrokeDataMap;
  plan: ReviewPlan;
  snapshot: { spawnOrdinal: number; schedulerRng: [number, number, number, number] };
  settings: DifficultySettings; paused: boolean; saveStatus: string;
  onPause: () => void; onResume: () => void; onSettings: () => void;
  onProgressChange: (report: ReviewProgressReport) => void;
  onEnd: (stats: SessionStats) => void; children: ReactNode;
};
function BattleScreen({ deck, strokeData, plan, snapshot, settings, paused, saveStatus, onPause, onResume, onSettings, onProgressChange, onEnd, children }: BattleProps) {
  const progressChangeRef = useRef(onProgressChange); progressChangeRef.current = onProgressChange;
  const options = useMemo<BattleOptions>(() => ({
    deck, plan, initialSnapshot: snapshot,
    onChange: (report) => progressChangeRef.current(report),
  }), [deck, plan, snapshot]);
  const mobile = useMobileLayout();
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = settings.reducedMotion || systemReducedMotion;
  const battle = useBattle(options, settings, paused, strokeData, !reducedMotion);
  const battleRef = useRef(battle); battleRef.current = battle;
  const [pinyin, setPinyin] = useState("");
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  // Round progress counts every resolved spawn (base plan + additive
  // retries). The denominator adds the still-unresolved committed work —
  // unreserved base spawns, open repair obligations not already being
  // served, and in-flight enemies — so the bar can never touch 100% and
  // then regress when a final-base miss creates a pending repair.
  const inFlightCount = battle.enemies.length + (battle.preparingEnemy ? 1 : 0);
  const total = Math.max(battle.stats.resolvedSpawns + battle.pendingWork + inFlightCount, 1);
  const progressCount = battle.stats.resolvedSpawns;
  const pinyinDisabled = !battle.target || paused || battle.learningPaused || battle.phase !== "pinyin";

  useEffect(() => {
    setPinyin("");
    const focusPinyin = () => {
      if (!paused && !battle.learningPaused && battle.phase === "pinyin") input.current?.focus({ preventScroll: true });
    };
    focusPinyin();
    window.addEventListener("focus", focusPinyin);
    return () => window.removeEventListener("focus", focusPinyin);
  }, [battle.learningPaused, battle.phase, battle.target?.id, paused]);
  // Desktop: while the battle screen is up during the pinyin phase, the hidden input always keeps focus.
  useEffect(() => {
    if (mobile || paused || battle.learningPaused || battle.phase !== "pinyin" || !battle.target) return;
    const interactive = "button, a, input, textarea, select, label";
    const focusPinyin = () => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const active = document.activeElement;
      if (active === input.current) return;
      if (active instanceof HTMLElement && active.closest(interactive)) return;
      input.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(interactive)) return;
      // Pressing anywhere else on the battlefield keeps typing focus instead of blurring the input.
      event.preventDefault();
      focusPinyin();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", focusPinyin);
    window.addEventListener("focus", focusPinyin);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", focusPinyin);
      window.removeEventListener("focus", focusPinyin);
    };
  }, [battle.learningPaused, battle.phase, battle.target, mobile, paused]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const current = battleRef.current;
      if (current.learningPaused) return;
      if (event.key === "Escape") { if (children) return; event.preventDefault(); paused ? onResume() : onPause(); return; }
      if (paused || event.repeat || current.phase !== "meaning") return;
      // Ctrl+R / Cmd+F and friends belong to the browser, not to the answer keys.
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toUpperCase();
      if (CHOICE_KEYS.includes(key as ChoiceKey)) {
        event.preventDefault();
        current.chooseMeaning(key as ChoiceKey);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [children, onPause, onResume, paused]);
  useEffect(() => {
    if (battle.sessionComplete && !ended.current) {
      ended.current = true;
      onEnd(battle.stats);
    }
  }, [battle.sessionComplete, battle.stats, onEnd]);

  const submitAnswer = () => { if (!composingRef.current) battle.submitPinyin(pinyin); };
  const submit = (event: FormEvent) => { event.preventDefault(); submitAnswer(); };
  const wordMap = useMemo(() => new Map(deck.words.map((word) => [word.id, word])), [deck]);
  const enemyViews = battle.enemies.flatMap((enemy) => {
    const word = wordMap.get(enemy.wordId);
    return word ? [{ ...enemy, word }] : [];
  });
  const preparingView = battle.preparingEnemy
    ? (() => {
      const word = wordMap.get(battle.preparingEnemy.wordId);
      return word ? { ...battle.preparingEnemy, word } : null;
    })()
    : null;
  const solvedId = battle.feedback?.kind === "correct" ? battle.feedback.id : null;

  return <main className={`paper battle-screen ${battle.phase}-phase ${reducedMotion ? "reduce-motion" : ""}`}>
    <header className="battle-hud">
      <div className="hud-level"><span className="seal">R</span><p><b>REVIEW</b><small>{battle.stats.resolvedSpawns} RESOLVED</small></p></div>
      <div className="hud-item"><small>SCORE</small><b>{battle.stats.score.toLocaleString()}</b></div>
      <div className="hud-item"><small>STREAK · PRESSURE</small><b className="cinnabar">{battle.streak} IN A ROW · {battle.performanceMultiplier.toFixed(2)}×</b></div>
      <div className="hud-mastery"><small>ROUND PROGRESS</small><span><i style={{ width: `${total ? progressCount / total * 100 : 0}%` }} /></span><b>{progressCount} / {total}</b></div>
      <span className={`save-state ${saveStatus}`}><i /> {statusLabel(saveStatus)}</span>
      <button className="pause-button" onClick={onPause} aria-label="Pause game">Ⅱ</button>
    </header>

    <section className="practice-sheet" aria-hidden="true">
      <GameCanvas
        enemies={enemyViews} preparingEnemy={preparingView} targetId={battle.target?.id ?? null} solvedId={solvedId}
        strokeData={strokeData} paused={paused || battle.learningPaused} reducedMotion={reducedMotion}
      />
    </section>

    <section className={`answer-console ${battle.phase}`} aria-label="Answer console">
      <div className="accessible-target-status">
        <span>{battle.phase === "meaning" ? battle.pinyinAutocompleted ? "Pinyin autocompleted" : "Pinyin confirmed" : battle.target ? "Locked target" : "Scanning"}</span>
        <strong lang="zh-Hans">{battle.targetWord?.displayHanzi ?? "No target"}</strong>
        {battle.phase === "meaning" && <span>{battle.targetWord?.displayPinyin}</span>}
        <em>{battle.target ? `Altitude ${Math.max(0, Math.round((1 - battle.target.progress) * 100))} percent` : "Awaiting target"}</em>
      </div>
      {battle.phase === "pinyin" ? <form className="pinyin-form" onSubmit={submit} onClick={() => input.current?.focus({ preventScroll: true })}>
        <div className={`typed-pinyin ${!pinyin ? "empty" : ""}`} aria-hidden="true"><HanziText text={pinyin} data={strokeData} accessible={false} /><span className="caret" /></div>
        <input
          className="pinyin-input" id="pinyin" ref={input} value={pinyin} aria-label="Pinyin answer"
          onChange={(event) => setPinyin(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
          onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
          autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode={mobile ? "none" : "text"}
          disabled={pinyinDisabled}
        />
      </form> : <div className="meaning-zone">
        <div className="meaning-heading"><span>{battle.audioError ? "AUDIO UNAVAILABLE — ANSWER STILL COUNTS" : battle.pinyinAutocompleted ? "TIME EXPIRED · PINYIN AUTOCOMPLETED" : <HanziText text="选择纸签释义 · CHOOSE MEANING" data={strokeData} />}</span><button onClick={battle.replay} disabled={battle.audioError}>↻ REPLAY AUDIO</button></div>
        <div className="meaning-grid">{battle.choices.map((choice) => {
          const keys = [...new Set(choice.shortcuts.map((shortcut) => shortcut.key))];
          const highlighted = new Set(choice.shortcuts.map((shortcut) => shortcut.index));
          return <button key={choice.label} aria-label={`Press ${keys.join(" or ")}: ${choice.label}`} onClick={() => battle.chooseMeaning(keys[0]!)} disabled={battle.learningPaused}>
            <span className="meaning-label">{choice.label.split("").map((letter, index) => highlighted.has(index)
              ? <mark key={index}>{letter}</mark>
              : HAN_CHARACTER.test(letter) ? <HanziText key={index} text={letter} data={strokeData} accessible={false} /> : letter)}</span>
          </button>;
        })}</div>
      </div>}
    </section>

    {battle.phase === "pinyin" && <MobileKeyboard
      disabled={pinyinDisabled} submitDisabled={pinyinDisabled || composing || !pinyin.trim()}
      backspaceDisabled={pinyinDisabled || pinyin.length === 0}
      onLetter={(letter) => setPinyin((value) => value + letter.toLowerCase())}
      onBackspace={() => setPinyin((value) => value.slice(0, -1))} onPause={onPause} onSubmit={submitAnswer}
    />}
    <div className="sr-live" aria-live="polite">{battle.targetWord ? `Target ${battle.targetWord.displayHanzi}. ${battle.phase === "pinyin" ? "Type pinyin" : battle.pinyinAutocompleted ? `Pinyin autocompleted as ${battle.targetWord.displayPinyin}. Choose meaning` : "Choose meaning"}.` : "Waiting for target"}</div>
    {battle.feedback && <FeedbackNotice feedback={battle.feedback} strokeData={strokeData} onDismiss={battle.dismissFeedback} />}
    {paused && !children && <PauseDialog onResume={onResume} onSettings={onSettings} onEnd={() => onEnd(battle.stats)} />}{children}
  </main>;
}

const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"] as const;
type TouchKey = string | "Backspace" | "Submit";

function MobileKeyboard({ disabled, submitDisabled, backspaceDisabled, onLetter, onBackspace, onPause, onSubmit }: {
  disabled: boolean; submitDisabled: boolean; backspaceDisabled: boolean;
  onLetter: (letter: string) => void; onBackspace: () => void; onPause: () => void; onSubmit: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const active = useRef<{ pointerId: number; key: TouchKey; startY: number; backspaceCommitted: boolean } | null>(null);
  const holdTimeout = useRef<number | null>(null);
  const holdInterval = useRef<number | null>(null);

  const stopRepeat = useCallback(() => {
    if (holdTimeout.current !== null) window.clearTimeout(holdTimeout.current);
    if (holdInterval.current !== null) window.clearInterval(holdInterval.current);
    holdTimeout.current = null; holdInterval.current = null;
  }, []);
  const startRepeat = useCallback(() => {
    stopRepeat();
    holdTimeout.current = window.setTimeout(() => {
      if (active.current?.key !== "Backspace") return;
      onBackspace();
      active.current.backspaceCommitted = true;
      holdInterval.current = window.setInterval(onBackspace, 80);
    }, 450);
  }, [onBackspace, stopRepeat]);
  const clearPointer = useCallback(() => {
    stopRepeat(); active.current = null; setPreview(null);
  }, [stopRepeat]);
  useEffect(() => {
    window.addEventListener("blur", clearPointer);
    return () => { window.removeEventListener("blur", clearPointer); stopRepeat(); };
  }, [clearPointer, stopRepeat]);
  useEffect(() => { if (disabled) clearPointer(); }, [clearPointer, disabled]);

  const keyAtPoint = (x: number, y: number): TouchKey | null => {
    const direct = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-touch-key]");
    if (direct?.dataset.touchKey && !direct.hasAttribute("disabled")) return direct.dataset.touchKey;
    const keys = [...document.querySelectorAll<HTMLElement>(".touch-keyboard [data-touch-key]:not(:disabled)")];
    let nearest: { key: TouchKey; distance: number } | null = null;
    for (const key of keys) {
      const rect = key.getBoundingClientRect();
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
      const distance = dx * dx + dy * dy;
      if (!nearest || distance < nearest.distance) nearest = { key: key.dataset.touchKey!, distance };
    }
    return nearest && nearest.distance <= 18 * 18 ? nearest.key : null;
  };
  const switchKey = (key: TouchKey) => {
    const state = active.current;
    if (!state || state.key === key) return;
    stopRepeat();
    state.key = key;
    state.backspaceCommitted = false;
    if (key === "Backspace") startRepeat();
    setPreview(key.length === 1 ? key : null);
  };
  const pointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (active.current) { clearPointer(); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-touch-key]");
    const key = button?.dataset.touchKey;
    if (!button || !key || button.disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    active.current = { pointerId: event.pointerId, key, startY: event.clientY, backspaceCommitted: false };
    if (key === "Backspace") startRepeat();
    setPreview(key.length === 1 ? key : null);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = active.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (state.startY - event.clientY > 76) { clearPointer(); return; }
    const key = keyAtPoint(event.clientX, event.clientY);
    if (key) switchKey(key);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!active.current) return;
    event.preventDefault();
    const key = keyAtPoint(event.clientX, event.clientY) ?? active.current.key;
    switchKey(key);
    const final = active.current;
    if (final && final.key.length === 1) onLetter(final.key);
    else if (final?.key === "Submit" && !submitDisabled) onSubmit();
    else if (final?.key === "Backspace" && !final.backspaceCommitted && !backspaceDisabled) onBackspace();
    else if (final?.key === "Pause") onPause();
    clearPointer();
  };
  const keyboardActivate = (key: TouchKey) => {
    if (key.length === 1) onLetter(key);
    else if (key === "Backspace") onBackspace();
    else if (key === "Pause") onPause();
    else onSubmit();
  };

  return <section
    className="touch-keyboard" aria-label="Custom QWERTY keyboard" aria-disabled={disabled}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={clearPointer}
  >
    {KEY_ROWS.map((row, rowIndex) => <div className={`key-row row-${rowIndex + 1}`} key={row}>{[...row].map((key) => <button
      type="button" key={key} data-touch-key={key} disabled={disabled}
      className={preview === key ? "pressed" : ""} onClick={(event) => { if (event.detail === 0) keyboardActivate(key); }}
    >{preview === key && <i aria-hidden="true">{key}</i>}<span>{key}</span></button>)}{rowIndex === 2 && <button
      type="button" className="backspace" data-touch-key="Backspace" disabled={backspaceDisabled} aria-label="Backspace"
      onClick={(event) => { if (event.detail === 0) keyboardActivate("Backspace"); }}
    >⌫</button>}</div>)}
    <div className="key-row row-4">
      <button type="button" className="keyboard-pause" data-touch-key="Pause" aria-label="Pause game" onClick={(event) => { if (event.detail === 0) keyboardActivate("Pause"); }}>Ⅱ</button>
      <button type="button" className="enter" data-touch-key="Submit" disabled={submitDisabled} onClick={(event) => { if (event.detail === 0) keyboardActivate("Submit"); }}>SUBMIT</button>
    </div>
  </section>;
}

function FeedbackNotice({ feedback, strokeData, onDismiss }: { feedback: NonNullable<ReturnType<typeof useBattle>["feedback"]>; strokeData: StrokeDataMap; onDismiss: () => void }) {
  // An autocomplete reveal is a miss with a retry obligation: even when the
  // meaning choice then succeeds it must never present as a clean DIRECT HIT.
  if (feedback.kind === "correct" && feedback.revealed) {
    return <aside className="breach-notice" role="status"><strong><HanziText text={feedback.word.displayHanzi} data={strokeData} /></strong><span>{feedback.word.displayPinyin}</span><b><HanziText text={feedback.word.meaning} data={strokeData} /></b><footer><span>PINYIN REVEALED · MEANING SAVED, RECALL RECORDED AS A MISS</span></footer></aside>;
  }
  if (feedback.kind === "correct" && (feedback.points ?? 0) >= 0) {
    return <aside className="hit-notice" role="status"><b>+{feedback.points ?? 0}</b><span>DIRECT HIT</span></aside>;
  }
  const blocking = feedback.kind !== "correct";
  const notice = <aside className="breach-notice" role={blocking ? "dialog" : "alert"} aria-modal={blocking ? true : undefined} aria-labelledby={blocking ? "learning-feedback-title" : undefined}><strong id={blocking ? "learning-feedback-title" : undefined}><HanziText text={feedback.word.displayHanzi} data={strokeData} /></strong><span>{feedback.word.displayPinyin}</span><b><HanziText text={feedback.word.meaning} data={strokeData} /></b>{feedback.typed && <em><HanziText text={`YOU TYPED: ${feedback.typed}`} data={strokeData} /></em>}<footer><span>{feedback.kind === "landed" ? "WORD REACHED THE GROUND" : "RECALL RECORDED"}</span></footer>{blocking && <button autoFocus className="primary" onClick={onDismiss}>CONTINUE</button>}</aside>;
  return blocking ? <div className="modal-backdrop learning-backdrop">{notice}</div> : notice;
}

function PauseDialog({ onResume, onSettings, onEnd }: { onResume: () => void; onSettings: () => void; onEnd: () => void }) {
  return <div className="modal-backdrop"><section className="pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title"><h2 id="pause-title">PAUSED</h2><button autoFocus className="primary" onClick={onResume}>RESUME</button><button onClick={onSettings}>SYSTEM SETTINGS</button><button className="danger" onClick={onEnd}>END SESSION</button></section></div>;
}

function NumberSetting({ label, value, min, max, step, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <label><span>{label} <b>{value}{suffix}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SettingsDialog({ settings, onApply, onClose }: { settings: DifficultySettings; onApply: (settings: DifficultySettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  const speedLabel = draft.enemySpeedMultiplier < 0.9 ? "SLOW" : draft.enemySpeedMultiplier > 1.1 ? "FAST" : "STANDARD";
  const update = <K extends keyof DifficultySettings>(key: K, value: DifficultySettings[K]) => setDraft((old) => ({ ...old, [key]: value }));
  return <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><small>MEMORY SCHEDULING RUNS ON FSRS · REVIEW PRESSURE IS ADJUSTABLE</small><h2 id="settings-title">SYSTEM SETTINGS</h2></header><div className="settings-body">
    <h3>LEARN MODE</h3>
    <NumberSetting label="NEW CARDS PER SESSION" value={draft.levelSize} min={5} max={100} step={5} onChange={(value) => update("levelSize", value)} />
    <h3>REVIEW MODE</h3>
    <NumberSetting label="SESSION LENGTH (BASE SPAWNS)" value={draft.reviewSessionLength} min={200} max={500} step={10} suffix=" WORDS" onChange={(value) => update("reviewSessionLength", value)} />
    <label><span>BASE WORD SPAWN RATE <b>1 EVERY {(draft.spawnIntervalMs / 1000).toFixed(2)}s · {Math.round(60000 / draft.spawnIntervalMs)}/MIN</b></span><input type="range" min="1500" max="10000" step="250" value={draft.spawnIntervalMs} onChange={(event) => update("spawnIntervalMs", Number(event.target.value))} /></label>
    <label><span>WORD SPEED <b>{speedLabel} · {draft.enemySpeedMultiplier.toFixed(2)}×</b></span><input className="mint-range" type="range" min="0.65" max="1.5" step="0.05" value={draft.enemySpeedMultiplier} onChange={(event) => update("enemySpeedMultiplier", Number(event.target.value))} /></label>
    <h3>ACCESSIBILITY</h3>
    <label className="volume"><span>MASTER VOLUME <b>{Math.round(draft.masterVolume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={draft.masterVolume} onChange={(event) => update("masterVolume", Number(event.target.value))} /></label>
    <label className="check"><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.checked)} /> REDUCED MOTION</label>
  </div><footer><button onClick={onClose}>CANCEL</button><button onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>RESET DEFAULTS</button><button autoFocus className="primary" onClick={() => onApply(draft)}>APPLY SETTINGS</button></footer></section></div>;
}

const RECENCY_CHIP_LABEL: Record<string, string> = { new: "NEW", recent: "RECENT", old: "OLD" };

function Summary({ stats, deck, strokeData, saveStatus, relearnBlocked, onStartRelearn, onNewReview, onGrades }: {
  stats: SessionStats; deck: RuntimeDeck | null; strokeData: StrokeDataMap; saveStatus: string;
  relearnBlocked: boolean;
  onStartRelearn: (wordKeys: string[]) => void; onNewReview: () => void; onGrades: () => void;
}) {
  const wordMap = new Map(deck?.words.map((word) => [word.id, word]) ?? []);
  // Most commonly wrong/missed words first: miss events dominate, then raw
  // wrong answers, then slower average recall.
  const ranking = [...stats.wordStats.entries()]
    .filter(([, item]) => item.misses > 0)
    .sort((left, right) =>
      right[1].misses - left[1].misses
      || (right[1].wrongPinyin + right[1].wrongMeaning + right[1].landed) - (left[1].wrongPinyin + left[1].wrongMeaning + left[1].landed)
      || right[1].totalPinyinMs - left[1].totalPinyinMs)
    .slice(0, 12);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ranking.map(([key]) => key)));
  const toggle = (key: string) => setSelected((old) => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const selection = ranking.map(([key]) => key).filter((key) => selected.has(key));
  const accuracy = stats.resolvedSpawns
    ? Math.round(stats.correct / stats.resolvedSpawns * 100)
    : 0;
  return <main className="summary-screen paper"><header><h1>REVIEW RANKINGS</h1>
    <p>{`BASE PLAN ${stats.baseSpawns} SPAWNS • ${stats.resolvedSpawns} RESOLVED${stats.repairSpawns > 0 ? ` • ${stats.repairSpawns} RETRIES` : ""}`}</p></header>
    <section className="stat-grid"><div><small>SCORE</small><b className="amber">+{stats.score.toLocaleString()}</b></div><div><small>ACCURACY</small><b className="mint">{accuracy}%</b></div><div><small>BEST STREAK</small><b className="pink">×{stats.bestStreak}</b></div><div><small>WORDS SERVED</small><b className="cyan">{stats.seen.size}</b></div></section>
    <section className="review-ranking"><h2>MOST REINFORCEMENT NEEDED</h2>{ranking.length === 0
      ? <p>Perfect round — no struggles or misses.</p>
      : <>
        <small>SELECT WORDS TO RE-LEARN, THEN START THE SESSION</small>
        <div className="ranking-table">{ranking.map(([key, item], index) => {
          const word = wordMap.get(key);
          const errors = item.wrongPinyin + item.wrongMeaning + item.landed;
          return <label key={key} className={`ranking-row ${selected.has(key) ? "is-selected" : ""}`}>
            <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} aria-label={`Re-learn ${word?.displayHanzi ?? reviewWordIdOf(key).wordId}`} />
            <b>#{index + 1}</b><strong><HanziText text={word?.displayHanzi ?? reviewWordIdOf(key).wordId} data={strokeData} /></strong><span>{word?.displayPinyin}</span>
            <span>{errors} WRONG · {item.misses} {item.misses === 1 ? "MISS" : "MISSES"}</span>
            <em className={`recency-chip is-${item.recency}`}>{RECENCY_CHIP_LABEL[item.recency] ?? item.recency.toUpperCase()}</em>
            <em>{item.attempts > 0 ? `${(item.totalPinyinMs / item.attempts / 1000).toFixed(1)}s AVG` : "—"}</em>
          </label>;
        })}</div>
      </>}
    </section>
    <footer>
      <button onClick={onGrades}>RETURN TO GRADES</button>
      {ranking.length > 0 && <button
        className="pink-button"
        disabled={relearnBlocked || selection.length === 0}
        title={relearnBlocked ? "Finish the active re-learn session first" : selection.length === 0 ? "Select at least one word" : undefined}
        onClick={() => onStartRelearn(selection)}
      >START RE-LEARNING ({selection.length})</button>}
      <button className="mint-button" onClick={onNewReview}>START NEW REVIEW</button>
    </footer>
    <div className="sr-only">{statusLabel(saveStatus)}</div>
  </main>;
}
