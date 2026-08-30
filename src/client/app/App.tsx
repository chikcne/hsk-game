import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CHOICE_KEYS, DECK_IDS, DECK_TOTALS, DEFAULT_SETTINGS, type ChoiceKey, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema, type DifficultySettings, type LevelProgress, type ReviewProgress, type SaveFile, type RuntimeDeck } from "../../shared/schemas";
import type { EncounterOutcome } from "../../domain/session/types";
import { createDemoDeck } from "../data/demoDeck";
import { createReviewDeck } from "../data/reviewDeck";
import { loadSave, putSave } from "../api/saves";
import { GameCanvas } from "../game/GameCanvas";
import { useBattle, type SessionStats } from "../state/useBattle";
import { unlockSoundEffects } from "../audio/soundEffects";

const deckLabel = (id: DeckId) => `HSK ${id.at(-1)}`;
const masteredCount = (level?: LevelProgress) => level ? Object.values(level.words).filter((word) => word.appearanceWeight === 1).length : 0;
const sectorActionLabel = (level?: LevelProgress) => level && level.nextSpawnOrdinal > 0 ? "CONTINUE" : "START";

async function loadRuntimeDeck(id: DeckId): Promise<RuntimeDeck> {
  try {
    const response = await fetch(`/game-data/${id}/deck.json`);
    if (!response.ok) throw new Error("Generated deck not found");
    return RuntimeDeckSchema.parse(await response.json());
  } catch {
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
  const [reviewWordKeys, setReviewWordKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<DeckId>("hsk-1");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<SessionStats | null>(null);

  useEffect(() => {
    void loadSave().then(({ save: loaded, online }) => {
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
    setMode("regular"); setSelected(id); setScreen("loading");
    setDeck(await loadRuntimeDeck(id));
    setPaused(false); setScreen("battle");
  };
  const deployReview = async () => {
    if (!saveRef.current) return;
    unlockSoundEffects();
    setMode("review"); setScreen("loading");
    const loaded = await Promise.all(DECK_IDS.map(async (id) => [id, await loadRuntimeDeck(id)] as const));
    const reviewDeck = createReviewDeck(new Map(loaded), saveRef.current.levels);
    if (reviewDeck.masteredWordKeys.size === 0) { setScreen("decks"); return; }
    setReviewWordKeys(reviewDeck.masteredWordKeys);
    setDeck(reviewDeck.deck);
    setPaused(false); setScreen("battle");
  };
  const applySettings = (settings: DifficultySettings) => {
    if (!saveRef.current) return;
    queueSnapshot({ ...saveRef.current, settings });
    setSettingsOpen(false);
  };
  const settings = save?.settings ?? { ...DEFAULT_SETTINGS };

  if (!save || screen === "loading") return <LoadingScreen hasSave={Boolean(save)} />;
  if (screen === "decks") return <>
    <DeckSelect save={save} settings={settings} selected={selected} onSelect={setSelected} onDeploy={deploy} onReview={deployReview} onSettings={() => setSettingsOpen(true)} saveStatus={saveStatus} />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "summary" && summary) return <Summary
    stats={summary} deckId={selected} deck={deck} level={save.levels[selected]} saveStatus={saveStatus}
    onAgain={() => void (summary.mode === "review" ? deployReview() : deploy(selected))}
    onSectors={() => setScreen("decks")}
  />;
  if (!deck) return <LoadingScreen hasSave />;

  return <BattleScreen
    key={`${mode}-${deck.fingerprint}-${screen}`}
    mode={mode}
    deck={deck}
    regularLevel={mode === "regular" ? save.levels[deck.id] : undefined}
    review={save.review}
    reviewWordKeys={reviewWordKeys}
    settings={settings}
    paused={paused || settingsOpen}
    saveStatus={saveStatus}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onSettings={() => setSettingsOpen(true)}
    onRegularChange={(level, outcome, points) => {
      const current = saveRef.current; if (!current) return;
      queueSnapshot({ ...current, levels: { ...current.levels, [level.deckId]: level }, lifetime: updateLifetime(current, outcome, points) });
    }}
    onReviewChange={(review, outcome, points) => {
      const current = saveRef.current; if (!current) return;
      queueSnapshot({ ...current, review, lifetime: updateLifetime(current, outcome, points) });
    }}
    onEnd={(stats) => { setSummary(stats); setPaused(false); setSettingsOpen(false); setScreen("summary"); }}
  >
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </BattleScreen>;
}

function LoadingScreen({ hasSave }: { hasSave: boolean }) {
  return <main className="loading-screen starfield"><div className="loader-logo">汉</div><h1>HANZI DEFENDER</h1><p>{hasSave ? "LOADING SECTOR DATA" : "CONNECTING TO DEFENSE NETWORK"}</p><div className="loading-bar"><i /></div><small>LOCAL-FIRST • OFFLINE READY</small></main>;
}

function DeckSelect({ save, settings, selected, onSelect, onDeploy, onReview, onSettings, saveStatus }: {
  save: SaveFile; settings: DifficultySettings; selected: DeckId; onSelect: (id: DeckId) => void;
  onDeploy: (id: DeckId) => void; onReview: () => void; onSettings: () => void; saveStatus: string;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const digit = Number(event.key);
      if (digit >= 1 && digit <= 6) onSelect(`hsk-${digit}` as DeckId);
      if (event.key === "Enter") void onDeploy(selected);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onDeploy, onSelect, selected]);
  const totalMastered = DECK_IDS.reduce((sum, id) => sum + masteredCount(save.levels[id]), 0);
  return <main className="deck-screen starfield">
    <header className="hero"><button className="icon-button settings-button" onClick={onSettings} aria-label="System settings">⚙</button><div className="eyebrow">MANDARIN DEFENSE COMMAND</div><h1>HANZI <span>DEFENDER</span></h1><p>CHOOSE A SECTOR TO DEFEND</p></header>
    <div className="profile-line"><span>PILOT <b>LOCAL-01</b></span><span className={`save-state ${saveStatus}`}>● AUTO-SAVE {saveStatus.toUpperCase()}</span></div>
    <section className="deck-grid" aria-label="HSK sectors">{DECK_IDS.map((id, index) => {
      const level = save.levels[id];
      const mastered = masteredCount(level);
      const total = level ? Object.keys(level.words).length : DECK_TOTALS[id];
      const percent = total ? mastered / total * 100 : 0;
      const active = id === selected;
      const levelNumber = level ? level.currentLevelIndex + 1 : 1;
      const levelTotal = Math.ceil(total / settings.levelSize);
      return <button key={id} className={`deck-card ${active ? "selected" : ""} ${level?.firstCompletedAt ? "cleared" : ""}`} onFocus={() => onSelect(id)} onMouseEnter={() => onSelect(id)} onClick={() => void onDeploy(id)}>
        <div className="deck-title"><strong>HSK {index + 1}</strong><em>{level?.firstCompletedAt ? "✦ CLEARED" : `LEVEL ${levelNumber}/${levelTotal}`}</em></div>
        <div className="deck-meta"><span>WORDS MASTERED</span><b>{mastered} / {total}</b></div>
        <div className="segment-bar"><i style={{ width: `${percent}%` }} /></div><div className="deploy">▸ {sectorActionLabel(level)}</div>
      </button>;
    })}</section>
    <section className="review-launch"><div><small>ANKI-STYLE CROSS-SECTOR REVIEW</small><strong>{totalMastered} MASTERED WORDS READY</strong></div><button className="pink-button" disabled={totalMastered === 0} onClick={() => void onReview()}>START REVIEW</button></section>
    <footer className="mission-strip"><div><small>NEXT MISSION</small><strong>{deckLabel(selected)} <span>•</span> DEFENSE GRID READY</strong></div><button onClick={() => void onDeploy(selected)}>{sectorActionLabel(save.levels[selected])} <span>→</span></button></footer>
  </main>;
}

type BattleProps = {
  mode: "regular" | "review"; deck: RuntimeDeck; regularLevel?: LevelProgress; review: ReviewProgress;
  reviewWordKeys: ReadonlySet<string>; settings: DifficultySettings; paused: boolean; saveStatus: string;
  onPause: () => void; onResume: () => void; onSettings: () => void;
  onRegularChange: (level: LevelProgress, outcome?: EncounterOutcome, points?: number) => void;
  onReviewChange: (review: ReviewProgress, outcome?: EncounterOutcome, points?: number) => void;
  onEnd: (stats: SessionStats) => void; children: ReactNode;
};
function BattleScreen({ mode, deck, regularLevel, review, reviewWordKeys, settings, paused, saveStatus, onPause, onResume, onSettings, onRegularChange, onReviewChange, onEnd, children }: BattleProps) {
  const regularChangeRef = useRef(onRegularChange); regularChangeRef.current = onRegularChange;
  const reviewChangeRef = useRef(onReviewChange); reviewChangeRef.current = onReviewChange;
  const options = useMemo(() => mode === "regular" ? {
    kind: "regular" as const, deck, initialLevel: regularLevel,
    onChange: (level: LevelProgress, outcome?: EncounterOutcome, points?: number) => regularChangeRef.current(level, outcome, points),
  } : {
    kind: "review" as const, deck, initialReview: review, masteredWordKeys: reviewWordKeys,
    onChange: (next: ReviewProgress, outcome?: EncounterOutcome, points?: number) => reviewChangeRef.current(next, outcome, points),
  }, [deck, mode, regularLevel, review, reviewWordKeys]);
  const battle = useBattle(options, settings, paused);
  const [pinyin, setPinyin] = useState("");
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  const mastered = battle.level ? masteredCount(battle.level) : 0;
  const total = mode === "regular" ? deck.words.length : reviewWordKeys.size;

  useEffect(() => {
    setPinyin("");
    if (!paused && !battle.learningPaused && battle.phase === "pinyin") input.current?.focus();
  }, [battle.learningPaused, battle.phase, battle.target?.id, paused]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (battle.learningPaused) return;
      if (event.key === "Escape") { event.preventDefault(); paused ? onResume() : onPause(); return; }
      if (paused || event.repeat || battle.phase !== "meaning") return;
      const key = event.key.toUpperCase();
      if (CHOICE_KEYS.includes(key as ChoiceKey)) battle.chooseMeaning(key as ChoiceKey);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [battle, onPause, onResume, paused]);
  useEffect(() => {
    if (mode === "review" && battle.reviewComplete && !ended.current) {
      ended.current = true;
      onEnd(battle.stats);
    }
  }, [battle.reviewComplete, battle.stats, mode, onEnd]);

  const submit = (event: FormEvent) => { event.preventDefault(); if (!composing) battle.submitPinyin(pinyin); };
  const enemyViews = battle.enemies.flatMap((enemy) => {
    const word = deck.words.find((item) => item.id === enemy.wordId);
    return word ? [{ ...enemy, word }] : [];
  });
  const hudLabel = mode === "review" ? "REVIEW" : deckLabel(deck.id);
  const levelLabel = battle.level ? `LEVEL ${battle.level.currentLevelIndex + 1}` : `${battle.stats.seen.size} REVIEWED`;
  return <main className="battle-screen starfield">
    <header className="battle-hud"><strong>{hudLabel}</strong><div><small>SCORE</small><b>{battle.stats.score.toString().padStart(6, "0")}</b></div><div><small>STREAK</small><b className="amber">×{battle.streak}</b></div><div className="hud-mastery"><small>{levelLabel}</small><div className="segment-bar"><i style={{ width: `${total ? mastered / total * 100 : 0}%` }} /></div><b>{mode === "review" ? `${battle.stats.seen.size}/${total}` : `${mastered}/${total}`}</b></div><span className={`save-state ${saveStatus}`}>● {saveStatus.toUpperCase()}</span><button className="icon-button" onClick={onPause} aria-label="Pause game">Ⅱ</button></header>
    <section className="arena"><GameCanvas enemies={enemyViews} targetId={battle.target?.id ?? null} /></section>
    <section className={`command-panel ${battle.phase}`} aria-label="Answer console"><div className="target-card"><small>{battle.phase === "meaning" ? "PINYIN CONFIRMED ✓" : battle.target ? "LOCKED TARGET" : "SCANNING"}</small><strong lang="zh-Hans">{battle.targetWord?.displayHanzi ?? "—"}</strong>{battle.phase === "meaning" && <span>{battle.targetWord?.displayPinyin}</span>}<em>{battle.target ? `ALTITUDE ${Math.max(0, Math.round((1 - battle.target.progress) * 100))}%` : "AWAITING SIGNAL"}</em></div>
      {battle.phase === "pinyin" ? <form className="pinyin-form" onSubmit={submit}><label htmlFor="pinyin">TYPE PINYIN — NO TONE MARKS</label><input id="pinyin" ref={input} value={pinyin} onChange={(event) => setPinyin(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={battle.target ? "type answer…" : "waiting for target…"} disabled={!battle.target || paused || battle.learningPaused} /><div className="form-help"><span><kbd>ENTER</kbd> FIRE</span><span>ü = v</span><span><kbd>ESC</kbd> PAUSE</span></div></form>
      : <div className="meaning-zone"><div className="meaning-heading"><span>{battle.audioError ? "AUDIO UNAVAILABLE — ANSWER STILL COUNTS" : "PRESS A HIGHLIGHTED LETTER"}</span><button onClick={battle.replay} disabled={battle.audioError}>↻ REPLAY AUDIO</button></div><div className="meaning-grid">{battle.choices.map((choice) => {
        const keys = [...new Set(choice.shortcuts.map((shortcut) => shortcut.key))];
        const highlighted = new Set(choice.shortcuts.map((shortcut) => shortcut.index));
        return <button key={choice.label} aria-label={`Press ${keys.join(" or ")}: ${choice.label}`} onClick={() => battle.chooseMeaning(keys[0]!)} disabled={battle.learningPaused}><span className="meaning-label">{choice.label.split("").map((letter, index) => highlighted.has(index) ? <mark key={index}>{letter}</mark> : letter)}</span></button>;
      })}</div></div>}
    </section>
    <div className="sr-live" aria-live="polite">{battle.targetWord ? `Target ${battle.targetWord.displayHanzi}. ${battle.phase === "pinyin" ? "Type pinyin" : "Choose meaning"}.` : "Waiting for target"}</div>
    {battle.feedback && <FeedbackNotice feedback={battle.feedback} onDismiss={battle.dismissFeedback} />}
    {paused && !children && <PauseDialog onResume={onResume} onSettings={onSettings} onEnd={() => onEnd(battle.stats)} />}{children}
  </main>;
}

function FeedbackNotice({ feedback, onDismiss }: { feedback: NonNullable<ReturnType<typeof useBattle>["feedback"]>; onDismiss: () => void }) {
  if (feedback.kind === "correct" && !feedback.struggled) return <aside className="hit-notice" role="status"><b>+{feedback.points}</b><span>DIRECT HIT</span></aside>;
  const priority = feedback.oldWeight !== undefined
    ? `MASTERY ${101 - feedback.oldWeight} → ${101 - (feedback.newWeight ?? feedback.oldWeight)} · DUE IN ${feedback.repeatAfterPhrases}`
    : `RECALL ${feedback.recallScoreMsPerChar === null || feedback.recallScoreMsPerChar === undefined ? "—" : `${Math.round(feedback.recallScoreMsPerChar)} MS/CHAR`} · INTERVAL ${feedback.repeatAfterPhrases}`;
  const notice = <aside className="breach-notice" role={feedback.kind === "miss" ? "dialog" : "alert"} aria-modal={feedback.kind === "miss" ? true : undefined} aria-labelledby={feedback.kind === "miss" ? "learning-feedback-title" : undefined}><small>// {feedback.kind === "landed" ? "ALIEN LANDED" : feedback.struggled ? "SLOW RECALL" : "ANSWER REVIEW"} //</small><strong id={feedback.kind === "miss" ? "learning-feedback-title" : undefined} lang="zh-Hans">{feedback.word.displayHanzi}</strong><span>{feedback.word.displayPinyin}</span><b>{feedback.word.meaning}</b>{feedback.typed && <em>YOU TYPED: {feedback.typed}</em>}<footer><span>{feedback.struggled ? "ADDED TO LEVEL POOL" : "RECALL RECORDED"}</span><span>{priority}</span></footer>{feedback.kind === "miss" && <button autoFocus className="primary" onClick={onDismiss}>CONTINUE DEFENSE</button>}</aside>;
  return feedback.kind === "miss" ? <div className="modal-backdrop learning-backdrop">{notice}</div> : notice;
}

function PauseDialog({ onResume, onSettings, onEnd }: { onResume: () => void; onSettings: () => void; onEnd: () => void }) {
  return <div className="modal-backdrop"><section className="pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title"><small>SIMULATION HALTED</small><h2 id="pause-title">PAUSED</h2><button autoFocus className="primary" onClick={onResume}>RESUME DEFENSE</button><button onClick={onSettings}>SYSTEM SETTINGS</button><button className="danger" onClick={onEnd}>END SESSION</button><p><kbd>ENTER</kbd> fire · press a meaning's highlighted letter</p></section></div>;
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
  return <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><small>EVERY LEARNING AND REVIEW PARAMETER IS ADJUSTABLE</small><h2 id="settings-title">SYSTEM SETTINGS</h2></header><div className="settings-body">
    <h3>INVASION PRESSURE</h3>
    <label><span>ENEMY SPAWN RATE <b>1 EVERY {(draft.spawnIntervalMs / 1000).toFixed(2)}s · {Math.round(60000 / draft.spawnIntervalMs)}/MIN</b></span><input type="range" min="1500" max="5000" step="250" value={draft.spawnIntervalMs} onChange={(event) => update("spawnIntervalMs", Number(event.target.value))} /></label>
    <label><span>ENEMY SPEED <b>{speedLabel} · {draft.enemySpeedMultiplier.toFixed(2)}×</b></span><input className="mint-range" type="range" min="0.65" max="1.5" step="0.05" value={draft.enemySpeedMultiplier} onChange={(event) => update("enemySpeedMultiplier", Number(event.target.value))} /></label>
    <h3>REGULAR LEVELS</h3>
    <NumberSetting label="NEW WORDS PER LEVEL" value={draft.levelSize} min={5} max={100} step={5} onChange={(value) => update("levelSize", value)} />
    <NumberSetting label="STRUGGLE THRESHOLD" value={draft.struggleThresholdMs / 1000} min={1} max={20} step={0.5} suffix="s" onChange={(value) => update("struggleThresholdMs", value * 1000)} />
    <NumberSetting label="CORRECT REPEAT BASE" value={draft.correctRepeatBasePhrases} min={5} max={100} step={1} suffix=" phrases" onChange={(value) => update("correctRepeatBasePhrases", value)} />
    <NumberSetting label="PHRASES SUBTRACTED PER PINYIN SECOND" value={draft.pinyinSecondsPerPhrase} min={0} max={5} step={0.25} onChange={(value) => update("pinyinSecondsPerPhrase", value)} />
    <NumberSetting label="MINIMUM CORRECT INTERVAL" value={draft.minimumCorrectRepeatPhrases} min={1} max={Math.min(50, draft.correctRepeatBasePhrases)} step={1} onChange={(value) => update("minimumCorrectRepeatPhrases", value)} />
    <NumberSetting label="MISTAKE REPEAT INTERVAL" value={draft.mistakeRepeatPhrases} min={1} max={30} step={1} suffix=" phrases" onChange={(value) => update("mistakeRepeatPhrases", value)} />
    <NumberSetting label="FAST-CORRECT MASTERY GAIN" value={draft.masteryCorrectDecrease} min={1} max={50} step={1} onChange={(value) => update("masteryCorrectDecrease", value)} />
    <NumberSetting label="SLOW-RECALL MASTERY LOSS" value={draft.masteryStruggleIncrease} min={1} max={50} step={1} onChange={(value) => update("masteryStruggleIncrease", value)} />
    <NumberSetting label="MISTAKE MASTERY LOSS" value={draft.masteryMistakeIncrease} min={1} max={99} step={1} onChange={(value) => update("masteryMistakeIncrease", value)} />
    <NumberSetting label="REPAIR RECALLS" value={draft.repairRepetitions} min={0} max={10} step={1} onChange={(value) => update("repairRepetitions", value)} />
    <div className="rule"><span>DEFAULT RESPONSE FORMULA</span><b>DUE = {draft.correctRepeatBasePhrases} − PINYIN SECONDS × {draft.pinyinSecondsPerPhrase}</b><em>10s → {Math.max(draft.minimumCorrectRepeatPhrases, Math.round(draft.correctRepeatBasePhrases - 10 * draft.pinyinSecondsPerPhrase))} PHRASES</em></div>
    <h3>ANKI-STYLE REVIEW</h3>
    <NumberSetting label="FIRST INTERVAL" value={draft.reviewInitialInterval} min={1} max={100} step={1} onChange={(value) => update("reviewInitialInterval", value)} />
    <NumberSetting label="GRADUATING INTERVAL" value={draft.reviewGraduatingInterval} min={2} max={500} step={1} onChange={(value) => update("reviewGraduatingInterval", value)} />
    <NumberSetting label="LAPSE INTERVAL" value={draft.reviewLapseInterval} min={1} max={30} step={1} onChange={(value) => update("reviewLapseInterval", value)} />
    <NumberSetting label="EASY MULTIPLIER" value={draft.reviewEasyMultiplier} min={1.3} max={4} step={0.1} suffix="×" onChange={(value) => update("reviewEasyMultiplier", value)} />
    <NumberSetting label="HARD MULTIPLIER" value={draft.reviewHardMultiplier} min={0.5} max={1.5} step={0.05} suffix="×" onChange={(value) => update("reviewHardMultiplier", value)} />
    <NumberSetting label="RECALL SCORE NEW-ANSWER WEIGHT" value={draft.recallScoreSmoothing} min={0.05} max={1} step={0.05} onChange={(value) => update("recallScoreSmoothing", value)} />
    <h3>ACCESSIBILITY</h3>
    <label className="volume"><span>MASTER VOLUME <b>{Math.round(draft.masterVolume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={draft.masterVolume} onChange={(event) => update("masterVolume", Number(event.target.value))} /></label>
    <label className="check"><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.checked)} /> REDUCED MOTION</label>
  </div><footer><button onClick={onClose}>CANCEL</button><button onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>RESET DEFAULTS</button><button autoFocus className="primary" onClick={() => onApply(draft)}>APPLY SETTINGS</button></footer></section></div>;
}

function Summary({ stats, deckId, deck, level, saveStatus, onAgain, onSectors }: {
  stats: SessionStats; deckId: DeckId; deck: RuntimeDeck | null; level?: LevelProgress; saveStatus: string;
  onAgain: () => void; onSectors: () => void;
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
      return rightProblems - leftProblems || right[1].struggles - left[1].struggles || (right[1].recallScoreMsPerChar ?? 0) - (left[1].recallScoreMsPerChar ?? 0);
    }).slice(0, 12);
  const next = level ? Object.entries(level.words).filter(([, item]) => item.introducedAtOrdinal !== null).sort((a, b) => b[1].appearanceWeight - a[1].appearanceWeight).slice(0, 4).map(([id]) => wordMap.get(id)?.displayHanzi ?? "?") : [];
  const isReview = stats.mode === "review";
  return <main className="summary-screen starfield"><header><h1>{isReview ? "REVIEW RANKINGS" : "DEFENSE REPORT"}</h1><p>{isReview ? "ALL MASTERED SECTORS • ROUND COMPLETE" : `${deckLabel(deckId)} • SESSION COMPLETE`}</p></header>
    <section className="stat-grid"><div><small>SCORE</small><b className="amber">+{stats.score.toLocaleString()}</b></div><div><small>ACCURACY</small><b className="mint">{accuracy}%</b></div><div><small>BEST STREAK</small><b className="pink">×{stats.bestStreak}</b></div><div><small>WORDS SEEN</small><b className="cyan">{stats.seen.size}</b></div></section>
    {isReview ? <section className="review-ranking"><h2>MOST REINFORCEMENT NEEDED</h2>{ranking.length === 0 ? <p>Perfect round — no struggles or misses.</p> : <div className="ranking-table">{ranking.map(([id, item], index) => {
      const word = wordMap.get(id); const errors = item.wrongPinyin + item.wrongMeaning + item.landed;
      return <div key={id}><b>#{index + 1}</b><strong lang="zh-Hans">{word?.displayHanzi ?? id.split(":").at(-1)}</strong><span>{word?.displayPinyin}</span><span>{errors} WRONG · {item.struggles} STRUGGLES</span><em>{item.recallScoreMsPerChar === null ? "—" : `${Math.round(item.recallScoreMsPerChar)} ms/char`}</em></div>;
    })}</div>}</section>
    : <section className="summary-details"><div className="mastery-report"><h2>SECTOR MASTERY <span>{mastered} / {total}</span></h2><div className="segment-bar"><i style={{ width: `${mastered / total * 100}%` }} /></div><p><b className="mint">+{stats.newlyMastered.size}</b> NEW WORDS MASTERED</p><p><b className="red">{stats.wrongPinyin + stats.wrongMeaning + stats.landed}</b> WORDS NEED REINFORCEMENT</p><p><b className="cyan">{stats.levelsCompleted}</b> LEVELS COMPLETED</p><small>NEXT UP</small><div className="next-up">{next.map((item, index) => <span key={index}>{item}</span>)}</div></div><div className="save-report"><small>SAVE STATUS</small><b className={saveStatus === "saved" ? "mint" : "red"}>{saveStatus === "saved" ? "✓ ALL PROGRESS SAVED" : "! PROGRESS CACHED LOCALLY"}</b><span>LAST CHECKPOINT<br />JUST NOW</span><button className="primary" onClick={onAgain}>CONTINUE</button></div></section>}
    <footer><button onClick={onSectors}>RETURN TO SECTORS</button><button className="pink-button" onClick={onAgain}>{isReview ? "NEXT REVIEW ROUND" : "DEFEND AGAIN"}</button></footer>
  </main>;
}
