import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CHOICE_KEYS, DECK_IDS, DECK_TOTALS, DEFAULT_SETTINGS, type ChoiceKey, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema, type DifficultySettings, type LevelProgress, type SaveFile, type RuntimeDeck } from "../../shared/schemas";
import type { EncounterOutcome } from "../../domain/session/types";
import { createDemoDeck, } from "../data/demoDeck";
import { loadSave, putSave } from "../api/saves";
import { GameCanvas } from "../game/GameCanvas";
import { useBattle, type SessionStats } from "../state/useBattle";

const deckLabel = (id: DeckId) => `HSK ${id.at(-1)}`;
const masteredCount = (level?: LevelProgress) => level ? Object.values(level.words).filter((word) => word.appearanceWeight === 1).length : 0;

export function App() {
  const [screen, setScreen] = useState<"decks" | "loading" | "battle" | "summary">("loading");
  const [save, setSave] = useState<SaveFile | null>(null);
  const saveRef = useRef<SaveFile | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "offline" | "error">("saving");
  const pendingSave = useRef<SaveFile | null>(null); const writing = useRef(false);
  const [deck, setDeck] = useState<RuntimeDeck | null>(null); const [selected, setSelected] = useState<DeckId>("hsk-1");
  const [settingsOpen, setSettingsOpen] = useState(false); const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<SessionStats | null>(null);

  useEffect(() => { void loadSave().then(({ save: loaded, online }) => { saveRef.current = loaded; setSave(loaded); setSaveStatus(online ? "saved" : "offline"); setScreen("decks"); }); }, []);
  useEffect(() => {
    const pagehide = () => {
      const current = saveRef.current; if (!current) return;
      const snapshot = { ...current } as Record<string, unknown>; delete snapshot.revision; delete snapshot.savedAt;
      navigator.sendBeacon?.("/api/saves/default/beacon", JSON.stringify({ expectedRevision: current.revision, snapshot }));
    };
    window.addEventListener("pagehide", pagehide); return () => window.removeEventListener("pagehide", pagehide);
  }, []);

  const drainSaves = useCallback(async () => {
    if (writing.current) return; writing.current = true;
    while (pendingSave.current) {
      const payload = pendingSave.current; pendingSave.current = null; setSaveStatus("saving");
      try {
        const authoritative = await putSave(payload);
        const queuedAfterWrite = pendingSave.current as SaveFile | null;
        if (queuedAfterWrite) pendingSave.current = { ...queuedAfterWrite, revision: authoritative.revision, savedAt: authoritative.savedAt };
        else { saveRef.current = authoritative; setSave(authoritative); }
        setSaveStatus("saved");
      } catch { setSaveStatus(navigator.onLine ? "error" : "offline"); break; }
    }
    writing.current = false;
  }, []);

  const queueSnapshot = useCallback((snapshot: SaveFile) => { saveRef.current = snapshot; setSave(snapshot); pendingSave.current = snapshot; void drainSaves(); }, [drainSaves]);

  const deploy = async (id: DeckId) => {
    setSelected(id); setScreen("loading");
    try {
      const response = await fetch(`/game-data/${id}/deck.json`); if (!response.ok) throw new Error("Generated deck not found");
      const loaded = RuntimeDeckSchema.parse(await response.json()); setDeck(loaded);
    } catch { setDeck(createDemoDeck(id)); }
    setPaused(false); setScreen("battle");
  };
  const applySettings = (settings: DifficultySettings) => { if (!saveRef.current) return; queueSnapshot({ ...saveRef.current, settings }); setSettingsOpen(false); };
  const settings = save?.settings ?? { ...DEFAULT_SETTINGS };

  if (!save || screen === "loading") return <LoadingScreen hasSave={Boolean(save)} />;
  if (screen === "decks") return <><DeckSelect save={save} selected={selected} onSelect={setSelected} onDeploy={deploy} onSettings={() => setSettingsOpen(true)} saveStatus={saveStatus} />{settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}</>;
  if (screen === "summary" && summary) return <Summary stats={summary} deckId={selected} deck={deck} level={save.levels[selected]} saveStatus={saveStatus} onAgain={() => void deploy(selected)} onSectors={() => setScreen("decks")} />;
  if (!deck) return <LoadingScreen hasSave />;
  return <BattleScreen key={`${deck.id}-${screen}`} deck={deck} save={save} settings={settings} paused={paused || settingsOpen}
    saveStatus={saveStatus} onPause={() => setPaused(true)} onResume={() => setPaused(false)} onSettings={() => setSettingsOpen(true)}
    onLevelChange={(level, outcome, points) => {
      const current = saveRef.current; if (!current) return;
      const lifetime = { ...current.lifetime };
      if (outcome) { lifetime.resolvedEnemies += 1; lifetime.score += points ?? 0; lifetime.totalThinkingMs += outcome.kind === "correct" || outcome.kind === "wrongMeaning" ? outcome.pinyinMs + outcome.meaningMs : outcome.kind === "wrongPinyin" ? outcome.pinyinMs : outcome.activeThinkingMs ?? 0; if (outcome.kind === "correct") lifetime.completeCorrect += 1; else lifetime[outcome.kind] += 1; }
      queueSnapshot({ ...current, levels: { ...current.levels, [deck.id]: level }, lifetime });
    }} onEnd={(stats) => { setSummary(stats); setPaused(false); setSettingsOpen(false); setScreen("summary"); }}>
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </BattleScreen>;
}

function LoadingScreen({ hasSave }: { hasSave: boolean }) {
  return <main className="loading-screen starfield"><div className="loader-logo">汉</div><h1>HANZI DEFENDER</h1><p>{hasSave ? "LOADING SECTOR DATA" : "CONNECTING TO DEFENSE NETWORK"}</p><div className="loading-bar"><i /></div><small>LOCAL-FIRST • OFFLINE READY</small></main>;
}

function DeckSelect({ save, selected, onSelect, onDeploy, onSettings, saveStatus }: { save: SaveFile; selected: DeckId; onSelect: (id: DeckId) => void; onDeploy: (id: DeckId) => void; onSettings: () => void; saveStatus: string }) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { const digit = Number(event.key); if (digit >= 1 && digit <= 6) { const id = `hsk-${digit}` as DeckId; onSelect(id); } if (event.key === "Enter") void onDeploy(selected); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onDeploy, onSelect, selected]);
  return <main className="deck-screen starfield"><header className="hero"><button className="icon-button settings-button" onClick={onSettings} aria-label="System settings">⚙</button><div className="eyebrow">MANDARIN DEFENSE COMMAND</div><h1>HANZI <span>DEFENDER</span></h1><p>CHOOSE A SECTOR TO DEFEND</p></header>
    <div className="profile-line"><span>PILOT <b>LOCAL-01</b></span><span className={`save-state ${saveStatus}`}>● AUTO-SAVE {saveStatus.toUpperCase()}</span></div>
    <section className="deck-grid" aria-label="HSK sectors">{DECK_IDS.map((id, index) => { const level = save.levels[id]; const mastered = masteredCount(level); const total = level ? Object.keys(level.words).length : DECK_TOTALS[id]; const percent = total ? mastered / total * 100 : 0; const active = id === selected; return <button key={id} className={`deck-card ${active ? "selected" : ""} ${level?.firstCompletedAt ? "cleared" : ""}`} onFocus={() => onSelect(id)} onMouseEnter={() => onSelect(id)} onClick={() => void onDeploy(id)}>
      <div className="deck-title"><strong>HSK {index + 1}</strong><em>{level?.firstCompletedAt ? "✦ CLEARED" : `${String(index + 1).padStart(2, "0")}A`}</em></div><div className="deck-meta"><span>WORDS MASTERED</span><b>{mastered} / {total}</b></div><div className="segment-bar"><i style={{ width: `${percent}%` }} /></div><div className="deploy">▸ {level ? "CONTINUE" : "DEPLOY"}</div></button>; })}</section>
    <footer className="mission-strip"><div><small>NEXT MISSION</small><strong>{deckLabel(selected)} <span>•</span> DEFENSE GRID READY</strong></div><button onClick={() => void onDeploy(selected)}>DEPLOY <span>→</span></button></footer>
  </main>;
}

type BattleProps = { deck: RuntimeDeck; save: SaveFile; settings: DifficultySettings; paused: boolean; saveStatus: string; onPause: () => void; onResume: () => void; onSettings: () => void; onLevelChange: (level: LevelProgress, outcome?: EncounterOutcome, points?: number) => void; onEnd: (stats: SessionStats) => void; children: ReactNode };
function BattleScreen({ deck, save, settings, paused, saveStatus, onPause, onResume, onSettings, onLevelChange, onEnd, children }: BattleProps) {
  const levelChangeRef = useRef(onLevelChange); levelChangeRef.current = onLevelChange;
  const stableLevelChange = useCallback((level: LevelProgress, outcome?: EncounterOutcome, points?: number) => levelChangeRef.current(level, outcome, points), []);
  const battle = useBattle(deck, save.levels[deck.id], settings, paused, stableLevelChange);
  const [pinyin, setPinyin] = useState(""); const [composing, setComposing] = useState(false); const input = useRef<HTMLInputElement>(null);
  const mastered = masteredCount(battle.level); const total = deck.words.length;
  useEffect(() => { setPinyin(""); if (!paused && battle.phase === "pinyin") input.current?.focus(); }, [battle.phase, battle.target?.id, paused]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); paused ? onResume() : onPause(); return; } if (paused || event.repeat || battle.phase !== "meaning") return; const key = event.key.toUpperCase(); if (CHOICE_KEYS.includes(key as ChoiceKey)) battle.chooseMeaning(key as ChoiceKey); else if (key === "R") battle.replay(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [battle, onPause, onResume, paused]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!composing) battle.submitPinyin(pinyin); };
  const enemyViews = battle.enemies.flatMap((enemy) => { const word = deck.words.find((item) => item.id === enemy.wordId); return word ? [{ ...enemy, word }] : []; });
  return <main className="battle-screen starfield"><header className="battle-hud"><strong>{deckLabel(deck.id)}</strong><div><small>SCORE</small><b>{battle.stats.score.toString().padStart(6, "0")}</b></div><div><small>STREAK</small><b className="amber">×{battle.streak}</b></div><div className="hud-mastery"><small>MASTERY</small><div className="segment-bar"><i style={{ width: `${mastered / total * 100}%` }} /></div><b>{mastered}/{total}</b></div><span className={`save-state ${saveStatus}`}>● {saveStatus.toUpperCase()}</span><button className="icon-button" onClick={onPause} aria-label="Pause game">Ⅱ</button></header>
    <section className="arena"><GameCanvas enemies={enemyViews} targetId={battle.target?.id ?? null} /></section>
    <section className={`command-panel ${battle.phase}`} aria-label="Answer console"><div className="target-card"><small>{battle.phase === "meaning" ? "PINYIN CONFIRMED ✓" : battle.target ? "LOCKED TARGET" : "SCANNING"}</small><strong lang="zh-Hans">{battle.targetWord?.displayHanzi ?? "—"}</strong>{battle.phase === "meaning" && <span>{battle.targetWord?.displayPinyin}</span>}<em>{battle.target ? `ALTITUDE ${Math.max(0, Math.round((1 - battle.target.progress) * 100))}%` : "AWAITING SIGNAL"}</em></div>
      {battle.phase === "pinyin" ? <form className="pinyin-form" onSubmit={submit}><label htmlFor="pinyin">TYPE PINYIN — NO TONE MARKS</label><input id="pinyin" ref={input} value={pinyin} onChange={(event) => setPinyin(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={battle.target ? "type answer…" : "waiting for target…"} disabled={!battle.target || paused} /><div className="form-help"><span><kbd>ENTER</kbd> FIRE</span><span>ü = v</span><span><kbd>ESC</kbd> PAUSE</span></div></form>
      : <div className="meaning-zone"><div className="meaning-heading"><span>{battle.audioError ? "AUDIO UNAVAILABLE — ANSWER STILL COUNTS" : "SELECT THE MEANING"}</span><button onClick={battle.replay} disabled={battle.audioError}>↻ R REPLAY AUDIO</button></div><div className="meaning-grid">{battle.choices.map((choice) => <button key={choice.key} onClick={() => battle.chooseMeaning(choice.key)}><kbd>{choice.key}</kbd><span>{choice.label}</span></button>)}</div></div>}
    </section>
    <div className="sr-live" aria-live="polite">{battle.targetWord ? `Target ${battle.targetWord.displayHanzi}. ${battle.phase === "pinyin" ? "Type pinyin" : "Choose meaning"}.` : "Waiting for target"}</div>
    {battle.feedback && <FeedbackNotice feedback={battle.feedback} />}
    {paused && !children && <PauseDialog onResume={onResume} onSettings={onSettings} onEnd={() => onEnd(battle.stats)} />}{children}
  </main>;
}

function FeedbackNotice({ feedback }: { feedback: NonNullable<ReturnType<typeof useBattle>["feedback"]> }) {
  if (feedback.kind === "correct") return <aside className="hit-notice" role="status"><b>+{feedback.points}</b><span>DIRECT HIT</span></aside>;
  return <aside className="breach-notice" role="alert"><small>// {feedback.kind === "landed" ? "ALIEN LANDED" : "SIGNAL BREACH"} //</small><strong lang="zh-Hans">{feedback.word.displayHanzi}</strong><span>{feedback.word.displayPinyin}</span><b>{feedback.word.meaning}</b>{feedback.typed && <em>YOU TYPED: {feedback.typed}</em>}<footer><span>STREAK RESET</span><span>PRIORITY {feedback.oldWeight} → {feedback.newWeight}</span></footer></aside>;
}

function PauseDialog({ onResume, onSettings, onEnd }: { onResume: () => void; onSettings: () => void; onEnd: () => void }) { return <div className="modal-backdrop"><section className="pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title"><small>SIMULATION HALTED</small><h2 id="pause-title">PAUSED</h2><button autoFocus className="primary" onClick={onResume}>RESUME DEFENSE</button><button onClick={onSettings}>SYSTEM SETTINGS</button><button className="danger" onClick={onEnd}>END SESSION</button><p><kbd>ENTER</kbd> fire · <kbd>A S D F H J K L</kbd> meaning · <kbd>R</kbd> replay</p></section></div>; }

function SettingsDialog({ settings, onApply, onClose }: { settings: DifficultySettings; onApply: (settings: DifficultySettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings); useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  const speedLabel = draft.enemySpeedMultiplier < 0.9 ? "SLOW" : draft.enemySpeedMultiplier > 1.1 ? "FAST" : "STANDARD";
  return <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><small>TAKE THE PRESSURE — ALL ENEMIES SHARE ONE SPEED</small><h2 id="settings-title">SYSTEM SETTINGS</h2></header><div className="settings-body"><h3>INVASION PRESSURE</h3><label><span>ENEMY SPAWN RATE <b>1 EVERY {(draft.spawnIntervalMs / 1000).toFixed(2)}s · {Math.round(60000 / draft.spawnIntervalMs)}/MIN</b></span><input type="range" min="1500" max="5000" step="250" value={draft.spawnIntervalMs} onChange={(event) => setDraft({ ...draft, spawnIntervalMs: Number(event.target.value) })} /></label><label><span>ENEMY SPEED <b>{speedLabel} · {draft.enemySpeedMultiplier.toFixed(2)}×</b></span><input className="mint-range" type="range" min="0.65" max="1.5" step="0.05" value={draft.enemySpeedMultiplier} onChange={(event) => setDraft({ ...draft, enemySpeedMultiplier: Number(event.target.value) })} /></label><div className="rule"><span>TARGETING RULE</span><b>✦ CLOSEST TO BASE IS ALWAYS HIGHLIGHTED</b><em>FIXED</em></div><label className="volume"><span>MASTER VOLUME <b>{Math.round(draft.masterVolume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={draft.masterVolume} onChange={(event) => setDraft({ ...draft, masterVolume: Number(event.target.value) })} /></label><label className="check"><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => setDraft({ ...draft, reducedMotion: event.target.checked })} /> REDUCED MOTION</label></div><footer><button onClick={onClose}>CANCEL</button><button onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>RESET DEFAULTS</button><button autoFocus className="primary" onClick={() => onApply(draft)}>APPLY SETTINGS</button></footer></section></div>;
}

function Summary({ stats, deckId, deck, level, saveStatus, onAgain, onSectors }: { stats: SessionStats; deckId: DeckId; deck: RuntimeDeck | null; level?: LevelProgress; saveStatus: string; onAgain: () => void; onSectors: () => void }) {
  const resolved = stats.correct + stats.wrongPinyin + stats.wrongMeaning + stats.landed; const accuracy = resolved ? Math.round(stats.correct / resolved * 100) : 0; const mastered = masteredCount(level); const total = level ? Object.keys(level.words).length : DECK_TOTALS[deckId];
  const next = level ? Object.entries(level.words).sort((a, b) => b[1].appearanceWeight - a[1].appearanceWeight).slice(0, 4).map(([id]) => deck?.words.find((word) => word.id === id)?.displayHanzi ?? "?") : [];
  return <main className="summary-screen starfield"><header><h1>DEFENSE REPORT</h1><p>{deckLabel(deckId)} • SESSION COMPLETE</p></header><section className="stat-grid"><div><small>SCORE</small><b className="amber">+{stats.score.toLocaleString()}</b></div><div><small>ACCURACY</small><b className="mint">{accuracy}%</b></div><div><small>BEST STREAK</small><b className="pink">×{stats.bestStreak}</b></div><div><small>WORDS SEEN</small><b className="cyan">{stats.seen.size}</b></div></section><section className="summary-details"><div className="mastery-report"><h2>SECTOR MASTERY <span>{mastered} / {total}</span></h2><div className="segment-bar"><i style={{ width: `${mastered / total * 100}%` }} /></div><p><b className="mint">+{stats.newlyMastered.size}</b> NEW WORDS MASTERED</p><p><b className="red">{stats.wrongPinyin + stats.wrongMeaning + stats.landed}</b> WORDS NEED REINFORCEMENT</p><small>NEXT UP</small><div className="next-up">{next.map((item, index) => <span key={index}>{item}</span>)}</div></div><div className="save-report"><small>SAVE STATUS</small><b className={saveStatus === "saved" ? "mint" : "red"}>{saveStatus === "saved" ? "✓ ALL PROGRESS SAVED" : "! PROGRESS CACHED LOCALLY"}</b><span>LAST CHECKPOINT<br />JUST NOW</span><button className="primary" onClick={onAgain}>CONTINUE</button></div></section><footer><button onClick={onSectors}>RETURN TO SECTORS</button><button className="pink-button" onClick={onAgain}>DEFEND AGAIN</button></footer></main>;
}
