import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CHOICE_KEYS, DECK_IDS, DECK_TOTALS, DEFAULT_SETTINGS, type ChoiceKey, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema, type DifficultySettings, type LevelProgress, type SaveFile, type RuntimeDeck } from "../../shared/schemas";
import { countDueReviewWords } from "../../domain/review";
import { countGraduated, curriculumLessonNumber, reconcileLevelProgress } from "../../domain/learning";
import type { EncounterOutcome } from "../../domain/session/types";
import { createDemoDeck } from "../data/demoDeck";
import { createReviewDeck } from "../data/reviewDeck";
import { loadStrokeBundle, loadStrokeBundles, loadUiStrokeBundle, mergeStrokeData, type StrokeDataMap } from "../data/strokeData";
import { loadSave, putSave } from "../api/saves";
import { GameCanvas } from "../game/GameCanvas";
import { HanziText } from "../game/HanziText";
import { useBattle, type SaveProgressUpdate, type SessionStats, type BattleOptions } from "../state/useBattle";
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

function updateLifetime(save: SaveFile, outcome: EncounterOutcome | undefined, points = 0): SaveFile["lifetime"] {
  const lifetime = { ...save.lifetime };
  if (!outcome) return lifetime;
  lifetime.resolvedEnemies += 1;
  lifetime.score += points;
  lifetime.totalThinkingMs += outcome.kind === "correct" || outcome.kind === "wrongMeaning"
    ? outcome.pinyinMs + outcome.meaningMs
    : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0;
  if (outcome.kind === "correct") lifetime.completeCorrect += 1;
  else lifetime[outcome.kind] += 1;
  return lifetime;
}

export function App() {
  const [screen, setScreen] = useState<"decks" | "loading" | "battle" | "summary">("loading");
  const [mode, setMode] = useState<"regular" | "review">("regular");
  const [save, setSave] = useState<SaveFile | null>(null);
  const saveRef = useRef<SaveFile | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "offline" | "error">("saving");
  const pendingSave = useRef<SaveFile | null>(null);
  const writing = useRef(false);
  const [deck, setDeck] = useState<RuntimeDeck | null>(null);
  const [uiStrokeData, setUiStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [strokeData, setStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [selected, setSelected] = useState<DeckId>("hsk-1");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<SessionStats | null>(null);
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
  }, [drainSaves]);

  const deploy = async (id: DeckId) => {
    unlockSoundEffects();
    setLoadError(null);
    setMode("regular"); setSelected(id); setScreen("loading");
    try {
      const hasProgress = saveRef.current?.levels[id] !== undefined;
      const [loadedDeck, loadedStrokes] = await Promise.all([loadRuntimeDeck(id, !hasProgress), loadStrokeBundle(id)]);
      setDeck(loadedDeck); setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setPaused(false); setScreen("battle");
    } catch {
      setDeck(null);
      setLoadError(`Could not load ${deckLabel(id)} data. Your saved progress was not changed.`);
      setScreen("decks");
    }
  };
  const deployReview = async () => {
    const current = saveRef.current;
    if (!current) return;
    // Review rounds are finite and only start when at least one due card has
    // also cleared its global ordinal cooldown.
    if (countDueReviewWords(current.levels, new Date(), current.spawnOrdinal) === 0) return;
    unlockSoundEffects();
    setLoadError(null);
    setMode("review"); setScreen("loading");
    try {
      const [loaded, loadedStrokes] = await Promise.all([
        Promise.all(DECK_IDS.map(async (id) => [id, await loadRuntimeDeck(id, current.levels[id] === undefined)] as const)),
        loadStrokeBundles(DECK_IDS),
      ]);
      const loadedDecks = new Map(loaded);
      let levels = current.levels;
      for (const [id, loadedDeck] of loaded) {
        const existing = levels[id];
        if (!existing || existing.deckFingerprint === loadedDeck.fingerprint) continue;
        const reconciled = reconcileLevelProgress(existing, loadedDeck, current.spawnOrdinal).level;
        levels = { ...levels, [id]: reconciled };
      }
      if (levels !== current.levels) queueSnapshot({ ...current, levels });
      if (countDueReviewWords(levels, new Date(), current.spawnOrdinal) === 0) {
        setScreen("decks");
        return;
      }
      const reviewDeck = createReviewDeck(loadedDecks, levels);
      setDeck(reviewDeck.deck); setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setPaused(false); setScreen("battle");
    } catch {
      setDeck(null);
      setLoadError("Could not load all saved grade data. Review was not started and progress was not changed.");
      setScreen("decks");
    }
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
    <DeckSelect save={save} settings={settings} selected={selected} strokeData={uiStrokeData} onSelect={setSelected} onDeploy={deploy} onReview={deployReview} onSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "summary" && summary) return <Summary
    stats={summary} deckId={selected} deck={deck} level={save.levels[selected]} saveStatus={saveStatus} strokeData={strokeData}
    onAgain={() => void (summary.mode === "review" ? deployReview() : deploy(selected))}
    onGrades={() => setScreen("decks")}
  />;
  if (!deck) return <LoadingScreen hasSave strokeData={uiStrokeData} />;

  return <BattleScreen
    key={`${mode}-${deck.fingerprint}-${screen}`}
    mode={mode}
    deck={deck}
    strokeData={strokeData}
    regularLevel={mode === "regular" ? save.levels[deck.id] : undefined}
    levels={save.levels}
    snapshot={{ spawnOrdinal: save.spawnOrdinal, schedulerRng: save.schedulerRng }}
    settings={settings}
    paused={paused || settingsOpen}
    saveStatus={saveStatus}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onSettings={() => setSettingsOpen(true)}
    onProgressChange={(update, outcome, points) => {
      const current = saveRef.current; if (!current) return;
      queueSnapshot({
        ...current,
        levels: { ...current.levels, ...update.levels } as SaveFile["levels"],
        spawnOrdinal: update.snapshot.spawnOrdinal,
        schedulerRng: update.snapshot.schedulerRng,
        lifetime: updateLifetime(current, outcome, points),
      });
    }}
    onEnd={(stats) => { setSummary(stats); setPaused(false); setSettingsOpen(false); setScreen("summary"); }}
  >
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </BattleScreen>;
}

function LoadingScreen({ hasSave, strokeData }: { hasSave: boolean; strokeData: StrokeDataMap }) {
  return <main className="loading-screen paper"><div className="loader-logo"><HanziText text="字多多" data={strokeData} /></div><h1>ZIDUODUO</h1><p>{hasSave ? "LOADING GRADE DATA" : "CONNECTING TO SERVER"}</p><div className="loading-bar"><i /></div><small>LOCAL-FIRST • OFFLINE READY</small></main>;
}

function DeckSelect({ save, settings, selected, strokeData, onSelect, onDeploy, onReview, onSettings }: {
  save: SaveFile; settings: DifficultySettings; selected: DeckId; strokeData: StrokeDataMap; onSelect: (id: DeckId) => void;
  onDeploy: (id: DeckId) => void; onReview: () => void; onSettings: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(() => DECK_IDS.indexOf(selected) + 1);
  const columnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const totalMastered = DECK_IDS.reduce((sum, id) => sum + masteredCount(save.levels[id]), 0);
  const dueReviewCount = countDueReviewWords(save.levels, new Date(), save.spawnOrdinal);
  const selectedLevel = save.levels[selected];
  const selectedMastered = masteredCount(selectedLevel);
  const selectedTotal = selectedLevel ? Object.keys(selectedLevel.words).length : DECK_TOTALS[selected];
  const lessonNumber = selectedLevel ? curriculumLessonNumber(selectedLevel, settings.levelSize) : 1;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const digit = Number(event.key);
      if (digit < 1 || digit > 6 || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[aria-modal="true"]')) return;
      const id = `hsk-${digit}` as DeckId;
      onSelect(id);
      setActiveIndex(digit);
      columnRefs.current[digit]?.focus();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onSelect]);

  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(7, index));
    setActiveIndex(next);
    if (next >= 1 && next <= 6) onSelect(DECK_IDS[next - 1]!);
    columnRefs.current[next]?.focus();
    columnRefs.current[next]?.scrollIntoView({ behavior: settings.reducedMotion ? "auto" : "smooth", block: "nearest", inline: "center" });
  };

  return <main className={`paper deck-screen ${settings.reducedMotion ? "reduce-motion" : ""}`}>
    <button className="settings-button" onClick={onSettings} aria-label="System settings">
      <img className="mooncake-icon" src="/images/mooncake-settings.png" alt="" />
    </button>
    <section
      className="scroll-menu"
      aria-label="Choose a grade or review"
      onKeyDown={(event) => {
        const focusedIndex = columnRefs.current.findIndex((item) => item === document.activeElement);
        const currentIndex = focusedIndex >= 0 ? focusedIndex : activeIndex;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); moveFocus((currentIndex + 1) % 8); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); moveFocus((currentIndex + 7) % 8); }
        else if (event.key === "Home") { event.preventDefault(); moveFocus(0); }
        else if (event.key === "End") { event.preventDefault(); moveFocus(7); }
      }}
    >
      <button
        ref={(node) => { columnRefs.current[0] = node; }}
        className={`scroll-column lesson ${activeIndex === 0 ? "selected" : ""}`}
        onFocus={() => setActiveIndex(0)} onMouseEnter={() => setActiveIndex(0)} onClick={() => void onDeploy(selected)}
      >
        <span className="column-kicker">NEXT LESSON</span><strong><HanziText text="续习" data={strokeData} vertical /></strong>
        <em><HanziText text={`${deckLabel(selected)} · 第${lessonNumber}课`} data={strokeData} vertical /></em>
        <span className="column-progress"><i style={{ height: `${selectedTotal ? selectedMastered / selectedTotal * 100 : 0}%` }} /></span>
        <span className="column-count">{selectedMastered} / {selectedTotal}</span><span className="seal action-seal"><HanziText text={gradeActionLabel(selectedLevel) === "START" ? "开始" : "续习"} data={strokeData} /></span>
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
          onClick={() => void onDeploy(id)}
          aria-label={`${deckLabel(id)}, ${mastered} of ${total} words mastered`}
        >
          <span className="column-kicker">HSK 0{index + 1}</span><strong><HanziText text={`${LEVEL_HANZI[index]}级`} data={strokeData} vertical /></strong>
          <em><HanziText text={LEVEL_DESCRIPTIONS[index]!} data={strokeData} vertical /></em><span className="column-progress"><i style={{ height: `${percent}%` }} /></span>
          <span className="column-count">{mastered} / {total}</span>{level?.firstCompletedAt && <span className="seal mini-seal"><HanziText text="成" data={strokeData} /></span>}
          {activeIndex === menuIndex && <span className="selection-brush" aria-hidden="true" />}
        </button>;
      })}
      </div>
      <button
        ref={(node) => { columnRefs.current[7] = node; }}
        className={`scroll-column review ${activeIndex === 7 ? "selected" : ""}`}
        onFocus={() => setActiveIndex(7)} onMouseEnter={() => setActiveIndex(7)}
        onClick={() => { if (dueReviewCount > 0) void onReview(); }} aria-disabled={dueReviewCount === 0}
      >
        <span className="column-kicker">REVIEW</span><strong><HanziText text="温故" data={strokeData} vertical /></strong><em><HanziText text="跨卷复习" data={strokeData} vertical /></em>
        <span className="column-progress"><i style={{ height: dueReviewCount > 0 ? "100%" : "0%" }} /></span>
        <span className="column-count"><HanziText text={`${dueReviewCount} 待复习`} data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="习" data={strokeData} /></span>
      </button>
    </section>
  </main>;
}

type BattleProps = {
  mode: "regular" | "review"; deck: RuntimeDeck; strokeData: StrokeDataMap; regularLevel?: LevelProgress;
  levels: Partial<Record<DeckId, LevelProgress>>;
  snapshot: { spawnOrdinal: number; schedulerRng: [number, number, number, number] };
  settings: DifficultySettings; paused: boolean; saveStatus: string;
  onPause: () => void; onResume: () => void; onSettings: () => void;
  onProgressChange: (update: SaveProgressUpdate, outcome?: EncounterOutcome, points?: number) => void;
  onEnd: (stats: SessionStats) => void; children: ReactNode;
};
function BattleScreen({ mode, deck, strokeData, regularLevel, levels, snapshot, settings, paused, saveStatus, onPause, onResume, onSettings, onProgressChange, onEnd, children }: BattleProps) {
  const progressChangeRef = useRef(onProgressChange); progressChangeRef.current = onProgressChange;
  const options = useMemo<BattleOptions>(() => mode === "regular" ? {
    kind: "regular" as const, deck, initialLevel: regularLevel, initialSnapshot: snapshot,
    onChange: (update, outcome, points) => progressChangeRef.current(update, outcome, points),
  } : {
    kind: "review" as const, deck, initialLevels: levels, initialSnapshot: snapshot,
    onChange: (update, outcome, points) => progressChangeRef.current(update, outcome, points),
  }, [deck, levels, mode, regularLevel, snapshot]);
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
  const mastered = battle.level ? masteredCount(battle.level) : 0;
  const total = deck.words.length;
  const progressCount = mode === "review" ? battle.stats.seen.size : mastered;
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
  const levelIndex = battle.level ? curriculumLessonNumber(battle.level, settings.levelSize) : 0;
  const hudLabel = mode === "review" ? "REVIEW" : deckLabel(deck.id);
  const levelLabel = battle.level ? `LESSON ${levelIndex}` : `${battle.stats.seen.size} REVIEWED`;
  const solvedId = battle.feedback?.kind === "correct" ? battle.feedback.id : null;

  return <main className={`paper battle-screen ${battle.phase}-phase ${reducedMotion ? "reduce-motion" : ""}`}>
    <header className="battle-hud">
      <div className="hud-level"><span className="seal">{mode === "review" ? "R" : deck.id.at(-1)}</span><p><b>{hudLabel}</b><small>{levelLabel} · {progressCount} / {total}</small></p></div>
      <div className="hud-item"><small>SCORE</small><b>{battle.stats.score.toLocaleString()}</b></div>
      <div className="hud-item"><small>STREAK · PRESSURE</small><b className="cinnabar">{battle.streak} IN A ROW · {battle.performanceMultiplier.toFixed(2)}×</b></div>
      <div className="hud-mastery"><small>{mode === "review" ? "REVIEW PROGRESS" : "LESSON MASTERY"}</small><span><i style={{ width: `${total ? progressCount / total * 100 : 0}%` }} /></span><b>{progressCount} / {total}</b></div>
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
        <span>{battle.target?.isNewWord ? "New word · " : ""}{battle.phase === "meaning" ? battle.pinyinAutocompleted ? "Pinyin autocompleted" : "Pinyin confirmed" : battle.target ? "Locked target" : "Scanning"}</span>
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
    <div className="sr-live" aria-live="polite">{battle.targetWord ? `${battle.target?.isNewWord ? "New word. " : ""}Target ${battle.targetWord.displayHanzi}. ${battle.phase === "pinyin" ? "Type pinyin" : battle.pinyinAutocompleted ? `Pinyin autocompleted as ${battle.targetWord.displayPinyin}. Choose meaning` : "Choose meaning"}.` : "Waiting for target"}</div>
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
    const state = active.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const key = keyAtPoint(event.clientX, event.clientY) ?? state.key;
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

/** Humanizes milliseconds-until-due for the recall feedback footer. */
function formatDue(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "NOW";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}M`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}H`;
  const days = minutes / (24 * 60);
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}D`;
}

function FeedbackNotice({ feedback, strokeData, onDismiss }: { feedback: NonNullable<ReturnType<typeof useBattle>["feedback"]>; strokeData: StrokeDataMap; onDismiss: () => void }) {
  if (feedback.kind === "correct" && !feedback.struggled) return <aside className="hit-notice" role="status"><b>+{feedback.points}</b><span>DIRECT HIT</span></aside>;
  const priority = `PINYIN ${feedback.ratings.pinyin.toUpperCase()}${feedback.ratings.meaning ? ` · MEANING ${feedback.ratings.meaning.toUpperCase()}` : ""} · NEXT ${feedback.nextDueInMs === null ? "—" : formatDue(feedback.nextDueInMs)}`;
  const blocking = feedback.kind !== "correct";
  const notice = <aside className="breach-notice" role={blocking ? "dialog" : "alert"} aria-modal={blocking ? true : undefined} aria-labelledby={blocking ? "learning-feedback-title" : undefined}><strong id={blocking ? "learning-feedback-title" : undefined}><HanziText text={feedback.word.displayHanzi} data={strokeData} /></strong><span>{feedback.word.displayPinyin}</span><b><HanziText text={feedback.word.meaning} data={strokeData} /></b>{feedback.typed && <em><HanziText text={`YOU TYPED: ${feedback.typed}`} data={strokeData} /></em>}<footer><span>{feedback.struggled ? "REPAIR SCHEDULED" : "RECALL RECORDED"}</span><span>{priority}</span></footer>{blocking && <button autoFocus className="primary" onClick={onDismiss}>CONTINUE</button>}</aside>;
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
  return <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><small>ARCADE PRESSURE IS ADJUSTABLE · MEMORY SCHEDULING RUNS ON FSRS</small><h2 id="settings-title">SYSTEM SETTINGS</h2></header><div className="settings-body">
    <h3>ARCADE PRESSURE</h3>
    <label><span>BASE WORD SPAWN RATE <b>1 EVERY {(draft.spawnIntervalMs / 1000).toFixed(2)}s · {Math.round(60000 / draft.spawnIntervalMs)}/MIN</b></span><input type="range" min="1500" max="10000" step="250" value={draft.spawnIntervalMs} onChange={(event) => update("spawnIntervalMs", Number(event.target.value))} /></label>
    <label><span>WORD SPEED <b>{speedLabel} · {draft.enemySpeedMultiplier.toFixed(2)}×</b></span><input className="mint-range" type="range" min="0.65" max="1.5" step="0.05" value={draft.enemySpeedMultiplier} onChange={(event) => update("enemySpeedMultiplier", Number(event.target.value))} /></label>
    <h3>REGULAR LEVELS</h3>
    <NumberSetting label="NEW WORDS PER LEVEL" value={draft.levelSize} min={5} max={100} step={5} onChange={(value) => update("levelSize", value)} />
    <h3>ACCESSIBILITY</h3>
    <label className="volume"><span>MASTER VOLUME <b>{Math.round(draft.masterVolume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={draft.masterVolume} onChange={(event) => update("masterVolume", Number(event.target.value))} /></label>
    <label className="check"><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.checked)} /> REDUCED MOTION</label>
  </div><footer><button onClick={onClose}>CANCEL</button><button onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>RESET DEFAULTS</button><button autoFocus className="primary" onClick={() => onApply(draft)}>APPLY SETTINGS</button></footer></section></div>;
}

function Summary({ stats, deckId, deck, level, saveStatus, strokeData, onAgain, onGrades }: {
  stats: SessionStats; deckId: DeckId; deck: RuntimeDeck | null; level?: LevelProgress; saveStatus: string; strokeData: StrokeDataMap;
  onAgain: () => void; onGrades: () => void;
}) {
  const resolved = stats.correct + stats.wrongPinyin + stats.wrongMeaning + stats.landed;
  const accuracy = resolved ? Math.round(stats.correct / resolved * 100) : 0;
  const mastered = masteredCount(level);
  const total = level ? Object.keys(level.words).length : DECK_TOTALS[deckId];
  const wordMap = new Map(deck?.words.map((word) => [word.id, word]) ?? []);
  const ranking = [...stats.wordStats.entries()]
    .filter(([, item]) => item.struggles > 0 || item.wrongPinyin + item.wrongMeaning + item.landed > 0)
    .sort((left, right) => {
      const leftProblems = left[1].wrongPinyin + left[1].wrongMeaning + left[1].landed;
      const rightProblems = right[1].wrongPinyin + right[1].wrongMeaning + right[1].landed;
      return rightProblems - leftProblems || right[1].struggles - left[1].struggles || right[1].totalPinyinMs - left[1].totalPinyinMs;
    }).slice(0, 12);
  // Weakest in-progress words first: never-seen before learning, then by how
  // recently they were last due.
  const next = level ? Object.entries(level.words)
    .filter(([, item]) => item.introducedAtOrdinal !== null && item.pinyin.state !== "review")
    .sort((a, b) => a[1].pinyin.reps - b[1].pinyin.reps || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([id]) => wordMap.get(id)?.displayHanzi ?? "?") : [];
  const isReview = stats.mode === "review";
  return <main className="summary-screen paper"><header><h1>{isReview ? "REVIEW RANKINGS" : "GRADE REPORT"}</h1><p>{isReview ? "ALL MASTERED GRADES • ROUND COMPLETE" : `${deckLabel(deckId)} • SESSION COMPLETE`}</p></header>
    <section className="stat-grid"><div><small>SCORE</small><b className="amber">+{stats.score.toLocaleString()}</b></div><div><small>ACCURACY</small><b className="mint">{accuracy}%</b></div><div><small>BEST STREAK</small><b className="pink">×{stats.bestStreak}</b></div><div><small>WORDS SEEN</small><b className="cyan">{stats.seen.size}</b></div></section>
    {isReview ? <section className="review-ranking"><h2>MOST REINFORCEMENT NEEDED</h2>{ranking.length === 0 ? <p>Perfect round — no struggles or misses.</p> : <div className="ranking-table">{ranking.map(([id, item], index) => {
      const word = wordMap.get(id); const errors = item.wrongPinyin + item.wrongMeaning + item.landed;
      return <div key={id}><b>#{index + 1}</b><strong><HanziText text={word?.displayHanzi ?? id.split(":").at(-1) ?? ""} data={strokeData} /></strong><span>{word?.displayPinyin}</span><span>{errors} WRONG · {item.struggles} STRUGGLES</span><em>{item.attempts > 0 ? `${(item.totalPinyinMs / item.attempts / 1000).toFixed(1)}s AVG` : "—"}</em></div>;
    })}</div>}</section>
    : <section className="summary-details"><div className="mastery-report"><h2>GRADE MASTERY <span>{mastered} / {total}</span></h2><div className="segment-bar"><i style={{ width: `${mastered / total * 100}%` }} /></div><p><b className="mint">+{stats.newlyMastered.size}</b> WORDS GRADUATED</p><p><b className="red">{stats.wrongPinyin + stats.wrongMeaning + stats.landed}</b> WORDS NEED REINFORCEMENT</p><p><b className="cyan">{stats.levelsCompleted}</b> LEVELS COMPLETED</p><small>NEXT UP</small><div className="next-up">{next.map((item, index) => <span key={index}><HanziText text={item} data={strokeData} /></span>)}</div></div><div className="save-report"><small>SAVE STATUS</small><b className={saveStatus === "saved" ? "mint" : "red"}>{saveStatus === "saved" ? "✓ ALL PROGRESS SAVED" : "! PROGRESS CACHED LOCALLY"}</b><span>LAST CHECKPOINT<br />JUST NOW</span><button className="primary" onClick={onAgain}>CONTINUE</button></div></section>}
    <footer><button onClick={onGrades}>RETURN TO GRADES</button><button className="pink-button" onClick={onAgain}>{isReview ? "NEXT REVIEW ROUND" : "PLAY AGAIN"}</button></footer>
  </main>;
}
