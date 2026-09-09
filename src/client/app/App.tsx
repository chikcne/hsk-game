import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Data, Effect } from "effect";
import { CHOICE_KEYS, DECK_IDS, DECK_TOTALS, DEFAULT_SETTINGS, type ChoiceKey, type DeckId } from "../../shared/constants";
import { RuntimeDeckSchema, type DifficultySettings, type RuntimeDeck } from "../../shared/schemas";
import { battlePools, masteryCategory } from "../../domain/battle";
import type { BattleConfig, VocabRow } from "../../shared/battle";
import { createBattleDeck } from "../data/battleDeck";
import {
  loadStrokeBundleEffect,
  loadStrokeBundlesEffect,
  loadUiStrokeBundleEffect,
  mergeStrokeData,
  type StrokeDataMap,
} from "../data/strokeData";
import { loadBattleSaveEffect, openBattleEffect, postVocabOutcome, putSettings } from "../api/battle";
import { GameCanvas } from "../game/GameCanvas";
import { HanziText } from "../game/HanziText";
import { useBattle, type BattleOptions, type OutcomePersistenceResult, type RuntimeWordPool, type SessionStats } from "../state/useBattle";
import { PinyinChoiceGrid, SelectedPinyin } from "./PinyinSelector";
import { unlockSoundEffects } from "../audio/soundEffects";
import { GlossaryScreen, type GlossaryDeck } from "./GlossaryScreen";

const TOTAL_WORDS = DECK_IDS.reduce((sum, id) => sum + DECK_TOTALS[id], 0);
const statusLabel = (status: string) => status === "saved" ? "PROGRESS SAVED" : status === "saving" ? "SAVING PROGRESS" : "SAVE ERROR";
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

/** Portrait play reads the mobile battle-input setting, landscape play the
 * desktop one. The effective mode is locked per enemy inside useBattle, so a
 * mid-battle rotation never erases an in-progress answer. */
function usePortraitOrientation() {
  const [portrait, setPortrait] = useState(() => typeof window !== "undefined" && window.matchMedia("(orientation: portrait)").matches);
  useEffect(() => {
    const query = window.matchMedia("(orientation: portrait)");
    const update = () => setPortrait(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return portrait;
}

/** A generated deck failed to fetch or validate. */
class DeckLoadError extends Data.TaggedError("DeckLoadError")<{
  readonly message: string;
  readonly cause?: Error;
}> {}

const toError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));

const fetchRuntimeDeck = (id: DeckId): Effect.Effect<RuntimeDeck, DeckLoadError, never> =>
  Effect.tryPromise({
    try: () => fetch(`/game-data/${id}/deck.json`),
    catch: (cause) => new DeckLoadError({ message: "Generated deck request failed", cause: toError(cause) }),
  }).pipe(
    Effect.flatMap((response) => response.ok
      ? Effect.succeed(response)
      : Effect.fail(new DeckLoadError({ message: `Generated deck not found (${response.status})` }))),
    Effect.flatMap((response) => Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: (cause) => new DeckLoadError({ message: "Generated deck response was not JSON", cause: toError(cause) }),
    })),
    Effect.flatMap((json) => Effect.try({
      try: () => RuntimeDeckSchema.parse(json),
      catch: (cause) => new DeckLoadError({ message: "Generated deck failed validation", cause: toError(cause) }),
    })),
  );

export function App() {
  const [screen, setScreen] = useState<"loading" | "menu" | "battle" | "summary" | "glossary">("loading");
  // Settings and battle tuning are unavailable until the server bundle
  // loads — there are no copied defaults to fall back to.
  const [settings, setSettings] = useState<DifficultySettings | null>(null);
  const [battleConfig, setBattleConfig] = useState<BattleConfig | null>(null);
  const [vocab, setVocab] = useState<readonly VocabRow[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saving");
  const [bootError, setBootError] = useState<string | null>(null);
  const [deck, setDeck] = useState<RuntimeDeck | null>(null);
  const [uiStrokeData, setUiStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [strokeData, setStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [summary, setSummary] = useState<{ stats: SessionStats; vocab: readonly VocabRow[] } | null>(null);
  const [pinyinPoolWords, setPinyinPoolWords] = useState<RuntimeWordPool>({ poolWords: [], outsideWords: [] });
  const [battleVocab, setBattleVocab] = useState<readonly VocabRow[]>([]);
  const [glossaryDecks, setGlossaryDecks] = useState<GlossaryDeck[]>([]);
  const [glossaryStrokeData, setGlossaryStrokeData] = useState<StrokeDataMap>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const runBoot = useCallback(() => {
    // Boot workflow: the UI stroke bundle resolves into state as soon as it
    // lands, while the save bundle (settings, vocab, battle config) gates
    // the transition to the menu. A failed load is surfaced honestly with a
    // retry — never substituted with local defaults.
    setBootError(null);
    setScreen("loading");
    const boot = Effect.gen(function* () {
      const [bundle, uiStrokes] = yield* Effect.all(
        [
          loadBattleSaveEffect,
          loadUiStrokeBundleEffect.pipe(
            Effect.tap((bundleStrokes) => Effect.sync(() => setUiStrokeData(bundleStrokes))),
          ),
        ],
        { concurrency: "unbounded" },
      );
      setSettings(bundle.settings);
      setBattleConfig(bundle.battleConfig);
      setVocab(bundle.vocab);
      setSaveStatus("saved");
      setScreen("menu");
    });
    Effect.runFork(boot.pipe(Effect.catchAll((error: unknown) => Effect.sync(() => {
      const detail = error instanceof Error && error.message ? error.message : String(error);
      setBootError(`The save server could not be reached (${detail}).`);
    }))));
  }, []);
  useEffect(() => { runBoot(); }, [runBoot]);

  /** Fire-and-forget outcome persistence with per-card serialization: two
   * rapid resolutions of the SAME word reach the server in order, so the
   * authoritative row never regresses an earlier outcome. */
  const pendingByCard = useRef(new Map<string, Promise<unknown>>());
  const persistOutcome = useCallback(async (cardId: string, cleanCorrect: boolean): Promise<OutcomePersistenceResult> => {
    const previous = pendingByCard.current.get(cardId) ?? Promise.resolve();
    const attempt = previous.then(() => postVocabOutcome(cardId, cleanCorrect));
    const chain = attempt.catch(() => undefined);
    pendingByCard.current.set(cardId, chain);
    void chain.then(() => {
      if (pendingByCard.current.get(cardId) === chain) pendingByCard.current.delete(cardId);
    });
    setSaveStatus("saving");
    try {
      const result = await attempt;
      setSaveStatus("saved");
      return result;
    } catch {
      setSaveStatus("error");
      return null;
    }
  }, []);

  /** Battle Mode is the main game mode: launch seeds curriculum positions
   * 1..5 on the server (first launch), loads every runtime deck and stroke
   * bundle, and starts the endless battle drawing live from the vocab. */
  const deployBattle = () => {
    if (!settings || !battleConfig) return;
    unlockSoundEffects();
    setLoadError(null);
    setScreen("loading");
    const deployBattleProgram = Effect.gen(function* () {
      const opened = yield* openBattleEffect;
      const [loaded, loadedStrokes] = yield* Effect.all(
        [
          Effect.all(DECK_IDS.map((id) => Effect.map(fetchRuntimeDeck(id), (loadedDeck) => [id, loadedDeck] as const)), { concurrency: "unbounded" }),
          loadStrokeBundlesEffect(DECK_IDS),
        ],
        { concurrency: "unbounded" },
      );
      const loadedDecks = new Map(loaded);
      const battleDeck = createBattleDeck(loadedDecks);
      // Selection Mode distractor sources: the launch-time pool words (close
      // distractors) plus every corpus word outside the vocabulary.
      const pools = battlePools(opened.vocab, battleConfig);
      const poolCardIds = new Set([...pools.low, ...pools.developing, ...pools.mastered].map((row) => row.cardId));
      const vocabCardIds = new Set(opened.vocab.map((row) => row.cardId));
      const poolWords = {
        poolWords: battleDeck.deck.words.filter((word) => poolCardIds.has(word.id)),
        outsideWords: [...loadedDecks].flatMap(([deckId, loadedDeck]) =>
          loadedDeck.words
            .filter((word) => !vocabCardIds.has(word.id))
            .map((word) => ({ ...word, id: `${deckId}:${word.id}` }))),
      };
      setVocab(opened.vocab);
      setBattleVocab(opened.vocab);
      setDeck(battleDeck.deck);
      setStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setPinyinPoolWords(poolWords);
      setPaused(false);
      setScreen("battle");
    });
    Effect.runFork(deployBattleProgram.pipe(Effect.catchAll(() => Effect.sync(() => {
      setDeck(null);
      setLoadError("Could not start the battle. Check that the save server is running, then try again.");
      setScreen("menu");
    }))));
  };

  /** The glossary loads the whole corpus and reads revealed/mastery state
   * straight from the vocab rows. */
  const openGlossary = () => {
    setLoadError(null);
    setScreen("loading");
    const loadGlossaryProgram: Effect.Effect<void, DeckLoadError, never> = Effect.gen(function* () {
      const [loaded, loadedStrokes] = yield* Effect.all(
        [
          Effect.all(DECK_IDS.map((id) => Effect.map(fetchRuntimeDeck(id), (loadedDeck) => ({ deckId: id, deck: loadedDeck } satisfies GlossaryDeck))), { concurrency: "unbounded" }),
          loadStrokeBundlesEffect(DECK_IDS),
        ],
        { concurrency: "unbounded" },
      );
      setGlossaryDecks(loaded);
      setGlossaryStrokeData(mergeStrokeData(uiStrokeData, loadedStrokes));
      setScreen("glossary");
    });
    Effect.runFork(loadGlossaryProgram.pipe(Effect.catchAll(() => Effect.sync(() => {
      setLoadError("Could not load the glossary data.");
      setScreen("menu");
    }))));
  };

  const applySettings = (next: DifficultySettings) => {
    setSettings(next);
    setSettingsOpen(false);
    void putSettings(next)
      .then((stored) => { setSettings(stored); setSaveStatus("saved"); })
      .catch(() => setSaveStatus("error"));
  };

  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = (settings?.reducedMotion ?? false) || systemReducedMotion;

  if (screen === "loading") return bootError
    ? <BootErrorScreen message={bootError} strokeData={uiStrokeData} onRetry={runBoot} />
    : <LoadingScreen hasData={vocab.length > 0} strokeData={uiStrokeData} />;
  if (!settings || !battleConfig) return <LoadingScreen hasData={vocab.length > 0} strokeData={uiStrokeData} />;
  if (screen === "menu") return <>
    {loadError && <p className="deck-load-error" role="alert">{loadError}</p>}
    <MainMenu
      vocab={vocab} battleConfig={battleConfig} settings={settings} strokeData={uiStrokeData}
      reducedMotion={reducedMotion}
      onBattle={() => void deployBattle()} onGlossary={openGlossary} onSettings={() => setSettingsOpen(true)}
    />
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </>;
  if (screen === "glossary") return <GlossaryScreen settings={settings} vocab={vocab} decks={glossaryDecks} strokeData={glossaryStrokeData} onExit={() => setScreen("menu")} />;
  if (screen === "summary" && summary) return <Summary stats={summary.stats} vocab={summary.vocab} battleConfig={battleConfig} deck={deck} strokeData={strokeData} saveStatus={saveStatus} onNewBattle={() => void deployBattle()} onMenu={() => setScreen("menu")} />;
  if (!deck || screen !== "battle") return <LoadingScreen hasData strokeData={uiStrokeData} />;

  return <BattleScreen
    key={`battle-${deck.fingerprint}`}
    deck={deck}
    strokeData={strokeData}
    initialVocab={battleVocab}
    battleConfig={battleConfig}
    pinyinPoolWords={pinyinPoolWords}
    settings={settings}
    paused={paused || settingsOpen}
    saveStatus={saveStatus}
    persistOutcome={persistOutcome}
    onVocabChange={setVocab}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onSettings={() => setSettingsOpen(true)}
    onEnd={(stats, finalVocab) => {
      setVocab(finalVocab);
      setSummary({ stats, vocab: finalVocab });
      setPaused(false); setSettingsOpen(false); setScreen("summary");
    }}
  >
    {settingsOpen && <SettingsDialog settings={settings} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
  </BattleScreen>;
}

function LoadingScreen({ hasData, strokeData }: { hasData: boolean; strokeData: StrokeDataMap }) {
  return <main className="loading-screen paper"><div className="loader-logo"><HanziText text="字多多" data={strokeData} /></div><h1>ZIDUODUO</h1><p>{hasData ? "LOADING BATTLE DATA" : "CONNECTING TO SERVER"}</p><div className="loading-bar"><i /></div><small>PROGRESS SAVED SERVER-SIDE</small></main>;
}

/** The save bundle could not be loaded and nothing downstream may run on
 * guessed defaults: state the failure and offer an explicit retry. */
function BootErrorScreen({ message, strokeData, onRetry }: { message: string; strokeData: StrokeDataMap; onRetry: () => void }) {
  return <main className="loading-screen paper">
    <div className="loader-logo"><HanziText text="字多多" data={strokeData} /></div>
    <h1>ZIDUODUO</h1>
    <p role="alert">COULD NOT LOAD SAVED PROGRESS</p>
    <p className="deck-load-error">{message}</p>
    <button autoFocus className="primary" onClick={onRetry}>RETRY</button>
  </main>;
}

/** The battle-first title menu: Battle Mode is the primary (and focused)
 * destination, Writing Practice remains implemented but is disabled, and the
 * Glossary reads the live vocabulary. */
const MODE_COUNT = 3;

function MainMenu({ vocab, battleConfig, settings, strokeData, reducedMotion, onBattle, onGlossary, onSettings }: {
  vocab: readonly VocabRow[]; battleConfig: BattleConfig; settings: DifficultySettings; strokeData: StrokeDataMap; reducedMotion: boolean;
  onBattle: () => void; onGlossary: () => void; onSettings: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mastered = vocab.filter((row) => masteryCategory(row.mastery, battleConfig) === "mastered").length;

  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(MODE_COUNT - 1, index));
    setActiveIndex(next);
    buttonRefs.current[next]?.focus();
  };

  return <main className={`paper deck-screen ${reducedMotion ? "reduce-motion" : ""}`}>
    <button className="settings-button" onClick={onSettings} aria-label="System settings">
      <img className="mooncake-icon" src="/images/mooncake-settings.png" alt="" />
    </button>
    <section
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
        autoFocus
        className={`scroll-column battle ${activeIndex === 0 ? "selected" : ""}`}
        onFocus={() => setActiveIndex(0)} onMouseEnter={() => setActiveIndex(0)} onClick={onBattle}
        aria-label={`Start battle, ${vocab.length} words in vocabulary, ${mastered} mastered`}
      >
        <span className="column-kicker">BATTLE MODE</span><strong><HanziText text="对战" data={strokeData} vertical /></strong>
        <em><HanziText text="无尽词战" data={strokeData} vertical /></em>
        <span className="column-progress"><i style={{ height: `${TOTAL_WORDS ? mastered / TOTAL_WORDS * 100 : 0}%` }} /></span>
        <span className="column-count"><HanziText text={`${vocab.length} 词 · ${mastered} 通`} data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="战" data={strokeData} /></span>
      </button>
      <button
        ref={(node) => { buttonRefs.current[1] = node; }}
        className={`scroll-column writing is-disabled ${activeIndex === 1 ? "selected" : ""}`}
        onFocus={() => setActiveIndex(1)} onMouseEnter={() => setActiveIndex(1)}
        onClick={() => undefined}
        aria-disabled
        aria-label="Writing practice is currently disabled"
      >
        <span className="column-kicker">WRITING MODE</span><strong><HanziText text="练字" data={strokeData} vertical /></strong>
        <em><HanziText text="暂停开放" data={strokeData} vertical /></em>
        <span className="column-progress"><i style={{ height: "0%" }} /></span>
        <span className="column-count"><HanziText text="未开放" data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="练" data={strokeData} /></span>
      </button>
      <button
        ref={(node) => { buttonRefs.current[2] = node; }}
        className={`scroll-column glossary ${activeIndex === 2 ? "selected" : ""}`}
        onFocus={() => setActiveIndex(2)} onMouseEnter={() => setActiveIndex(2)} onClick={onGlossary}
        aria-label={`Open glossary, ${vocab.length} of ${TOTAL_WORDS} words encountered`}
      >
        <span className="column-kicker">GLOSSARY</span><strong><HanziText text="词卷" data={strokeData} vertical /></strong>
        <em><HanziText text="词库总览" data={strokeData} vertical /></em>
        <span className="column-progress"><i style={{ height: `${TOTAL_WORDS ? vocab.length / TOTAL_WORDS * 100 : 0}%` }} /></span>
        <span className="column-count"><HanziText text={`${vocab.length} 已收入`} data={strokeData} vertical /></span><span className="seal action-seal"><HanziText text="词" data={strokeData} /></span>
      </button>
    </section>
  </main>;
}

type BattleProps = {
  deck: RuntimeDeck; strokeData: StrokeDataMap;
  initialVocab: readonly VocabRow[];
  battleConfig: BattleConfig;
  pinyinPoolWords: RuntimeWordPool;
  settings: DifficultySettings; paused: boolean; saveStatus: string;
  persistOutcome: BattleOptions["persistOutcome"];
  onVocabChange: (vocab: readonly VocabRow[]) => void;
  onPause: () => void; onResume: () => void; onSettings: () => void;
  onEnd: (stats: SessionStats, vocab: readonly VocabRow[]) => void;
  children: ReactNode;
};
function BattleScreen({ deck, strokeData, initialVocab, battleConfig, pinyinPoolWords, settings, paused, saveStatus, persistOutcome, onVocabChange, onPause, onResume, onSettings, onEnd, children }: BattleProps) {
  const options = useMemo<BattleOptions>(() => ({
    deck, initialVocab, battleConfig, pinyinPoolWords, persistOutcome, onVocabChange,
  }), [battleConfig, deck, initialVocab, pinyinPoolWords, persistOutcome, onVocabChange]);
  const mobile = useMobileLayout();
  const portrait = usePortraitOrientation();
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = (settings?.reducedMotion ?? false) || systemReducedMotion;
  const battleInputMode = portrait ? settings.mobileReviewMode : settings.desktopReviewMode;
  const battle = useBattle(options, settings, paused, strokeData, !reducedMotion, battleInputMode);
  const battleRef = useRef(battle); battleRef.current = battle;
  const [pinyin, setPinyin] = useState("");
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const selection = battle.phase === "pinyin" ? battle.selection : null;
  // The locked input mode — not the selection view — decides whether Typing
  // Mode's QWERTY panel may render: `selection` stays null until the first
  // target locks (and in every gap between enemies), so keying the keyboard
  // off it alone would flash it at the start of Selection Mode battles.
  const typing = battle.phase === "pinyin" && battle.inputMode === "typing" && !selection;
  const pinyinDisabled = !battle.target || paused || battle.learningPaused || battle.phase !== "pinyin";

  useEffect(() => {
    setPinyin("");
    // The hidden typing input only exists (and only grabs focus) in Typing
    // Mode; Selection Mode answers through ordinary focusable buttons.
    const focusPinyin = () => {
      if (typing && !paused && !battle.learningPaused && battle.phase === "pinyin") input.current?.focus({ preventScroll: true });
    };
    focusPinyin();
    window.addEventListener("focus", focusPinyin);
    return () => window.removeEventListener("focus", focusPinyin);
  }, [battle.learningPaused, battle.phase, battle.target?.id, paused, typing]);
  // Desktop: while the battle screen is up during a TYPING pinyin phase, the
  // hidden input always keeps focus.
  useEffect(() => {
    if (mobile || !typing || paused || battle.learningPaused || battle.phase !== "pinyin" || !battle.target) return;
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
  }, [battle.learningPaused, battle.phase, battle.target, mobile, paused, typing]);
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
  const masteryTotal = battle.masteryCounts.low + battle.masteryCounts.developing + battle.masteryCounts.mastered;

  return <main className={`paper battle-screen ${battle.phase}-phase review-input-${battle.inputMode} ${reducedMotion ? "reduce-motion" : ""}`}>
    <header className="battle-hud">
      <div className="hud-level"><span className="seal"><HanziText text="战" data={strokeData} /></span><p><b>BATTLE</b><small>{battle.stats.resolvedSpawns} RESOLVED</small></p></div>
      <div className="hud-item"><small>SCORE</small><b>{battle.stats.score.toLocaleString()}</b></div>
      <div className="hud-item"><small>STREAK · PRESSURE</small><b className="cinnabar">{battle.streak} IN A ROW · {battle.performanceMultiplier.toFixed(2)}×</b></div>
      <div className="hud-mastery"><small>VOCABULARY</small><span className="mastery-bar" role="img" aria-label={`${battle.masteryCounts.low} low, ${battle.masteryCounts.developing} developing, ${battle.masteryCounts.mastered} mastered`}>
        <i className="seg-low" style={{ flexGrow: battle.masteryCounts.low }} />
        <i className="seg-developing" style={{ flexGrow: battle.masteryCounts.developing }} />
        <i className="seg-mastered" style={{ flexGrow: battle.masteryCounts.mastered }} />
      </span><b>{masteryTotal} 词</b></div>
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
      {battle.phase === "pinyin" ? (selection ? <div className="pinyin-selector">
        <SelectedPinyin selection={selection} />
        {/* Desktop keeps the compact grid inside the ~220px answer area;
            mobile renders the same grid in the QWERTY region instead. */}
        {!mobile && <PinyinChoiceGrid selection={selection} disabled={pinyinDisabled} onChoose={battle.choosePinyin} />}
      </div> : <form className="pinyin-form" onSubmit={submit} onClick={() => input.current?.focus({ preventScroll: true })}>
        <div className={`typed-pinyin ${!pinyin ? "empty" : ""}`} aria-hidden="true"><HanziText text={pinyin} data={strokeData} accessible={false} /><span className="caret" /></div>
        <input
          className="pinyin-input" id="pinyin" ref={input} value={pinyin} aria-label="Pinyin answer"
          onChange={(event) => setPinyin(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
          onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
          autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode={mobile ? "none" : "text"}
          disabled={pinyinDisabled}
        />
      </form>) : <div className="meaning-zone">
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

    {typing && <MobileKeyboard
      disabled={pinyinDisabled} submitDisabled={pinyinDisabled || composing || !pinyin.trim()}
      backspaceDisabled={pinyinDisabled || pinyin.length === 0}
      onLetter={(letter) => setPinyin((value) => value + letter.toLowerCase())}
      onBackspace={() => setPinyin((value) => value.slice(0, -1))} onPause={onPause} onSubmit={submitAnswer}
    />}
    {battle.phase === "pinyin" && selection && <section className="touch-selector" aria-label="Pinyin selector">
      <PinyinChoiceGrid selection={selection} disabled={pinyinDisabled} onChoose={battle.choosePinyin} />
    </section>}
    <div className="sr-live" aria-live="polite">{battle.targetWord ? `Target ${battle.targetWord.displayHanzi}. ${battle.phase === "pinyin"
      ? selection
        ? `Select pinyin, character ${selection.charIndex + 1} of ${selection.charCount}. Selected ${selection.selected.join(" ") || "nothing"}.`
        : "Type pinyin"
      : battle.pinyinAutocompleted ? `Pinyin autocompleted as ${battle.targetWord.displayPinyin}. Choose meaning` : "Choose meaning"}.` : "Waiting for target"}</div>
    {battle.feedback && <FeedbackNotice feedback={battle.feedback} strokeData={strokeData} onDismiss={battle.dismissFeedback} />}
    {paused && !children && <PauseDialog onResume={onResume} onSettings={onSettings} onEnd={() => onEnd(battle.stats, battle.vocab)} />}{children}
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
      const dx = x < rect.left ? rect.left - x : x > rect.right ? rect.right - x : 0;
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? rect.bottom - y : 0;
      const distance = dx * dx + dy * dy;
      if (!nearest || nearest.distance > distance) nearest = { key: key.dataset.touchKey!, distance };
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
  // An autocomplete reveal is a miss: even when the meaning choice then
  // succeeds it must never present as a clean DIRECT HIT.
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
  return <div className="modal-backdrop"><section className="pause-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-title"><h2 id="pause-title">PAUSED</h2><button autoFocus className="primary" onClick={onResume}>RESUME</button><button onClick={onSettings}>SYSTEM SETTINGS</button><button className="danger" onClick={onEnd}>END BATTLE</button></section></div>;
}

function NumberSetting({ label, value, min, max, step, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return <label><span>{label} <b>{value}{suffix}</b></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

const BATTLE_INPUT_OPTIONS: Array<{ value: DifficultySettings["desktopReviewMode"]; label: string }> = [
  { value: "typing", label: "Typing Mode" },
  { value: "selection", label: "Selection Mode" },
];

/** The pinyin answer style dropdown. Landscape play (desktop) reads the
 * desktop setting, portrait play (mobile) the mobile setting; each is locked
 * per enemy and only takes effect on the next target. */
function BattleInputSetting<K extends "desktopReviewMode" | "mobileReviewMode">({ label, value, onChange }: { label: string; value: DifficultySettings[K]; onChange: (value: DifficultySettings[K]) => void }) {
  return <label className="mode-select"><span>{label} <b>{value === "selection" ? "SELECTION" : "TYPING"}</b></span>
    <select value={value} onChange={(event) => onChange(event.target.value as DifficultySettings[K])}>
      {BATTLE_INPUT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function SettingsDialog({ settings, onApply, onClose }: { settings: DifficultySettings; onApply: (settings: DifficultySettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  const speedLabel = draft.enemySpeedMultiplier < 0.9 ? "SLOW" : draft.enemySpeedMultiplier > 1.1 ? "FAST" : "STANDARD";
  const update = <K extends keyof DifficultySettings>(key: K, value: DifficultySettings[K]) => setDraft((old) => ({ ...old, [key]: value }));
  return <div className="modal-backdrop"><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><small>BATTLE PACING AND ACCESSIBILITY ARE ADJUSTABLE</small><h2 id="settings-title">SYSTEM SETTINGS</h2></header><div className="settings-body">
    <h3>BATTLE MODE</h3>
    <label><span>WORD SPAWN RATE <b>1 EVERY {(draft.spawnIntervalMs / 1000).toFixed(2)}s · {Math.round(60000 / draft.spawnIntervalMs)}/MIN</b></span><input type="range" min="1500" max="10000" step="250" value={draft.spawnIntervalMs} onChange={(event) => update("spawnIntervalMs", Number(event.target.value))} /></label>
    <label><span>WORD SPEED <b>{speedLabel} · {draft.enemySpeedMultiplier.toFixed(2)}×</b></span><input className="mint-range" type="range" min="0.65" max="1.5" step="0.05" value={draft.enemySpeedMultiplier} onChange={(event) => update("enemySpeedMultiplier", Number(event.target.value))} /></label>
    <BattleInputSetting label="Desktop Battle Input" value={draft.desktopReviewMode} onChange={(value) => update("desktopReviewMode", value)} />
    <BattleInputSetting label="Mobile Battle Input" value={draft.mobileReviewMode} onChange={(value) => update("mobileReviewMode", value)} />
    <h3>ACCESSIBILITY</h3>
    <label className="volume"><span>MASTER VOLUME <b>{Math.round(draft.masterVolume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value={draft.masterVolume} onChange={(event) => update("masterVolume", Number(event.target.value))} /></label>
    <label className="check"><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.checked)} /> REDUCED MOTION</label>
  </div><footer><button onClick={onClose}>CANCEL</button><button onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>RESET DEFAULTS</button><button autoFocus className="primary" onClick={() => onApply(draft)}>APPLY SETTINGS</button></footer></section></div>;
}

const MASTERY_CHIP_LABEL = { low: "LOW", developing: "DEVELOPING", mastered: "MASTERED" } as const;

function Summary({ stats, vocab, battleConfig, deck, strokeData, saveStatus, onNewBattle, onMenu }: {
  stats: SessionStats; vocab: readonly VocabRow[]; battleConfig: BattleConfig; deck: RuntimeDeck | null; strokeData: StrokeDataMap; saveStatus: string;
  onNewBattle: () => void; onMenu: () => void;
}) {
  const wordMap = new Map(deck?.words.map((word) => [word.id, word]) ?? []);
  const vocabByCard = new Map(vocab.map((row) => [row.cardId, row]));
  // Most commonly wrong/missed words first: miss events dominate, then raw
  // wrong answers, then slower average recall.
  const ranking = [...stats.wordStats.entries()]
    .filter(([, item]) => item.misses > 0)
    .sort((left, right) =>
      right[1].misses - left[1].misses
      || (right[1].wrongPinyin + right[1].wrongMeaning + right[1].landed) - (left[1].wrongPinyin + left[1].wrongMeaning + left[1].landed)
      || right[1].totalPinyinMs - left[1].totalPinyinMs)
    .slice(0, 12);
  const accuracy = stats.resolvedSpawns
    ? Math.round(stats.correct / stats.resolvedSpawns * 100)
    : 0;
  return <main className="summary-screen paper"><header><h1>BATTLE RANKINGS</h1>
    <p>{`${stats.resolvedSpawns} RESOLVED · ${stats.seen.size} WORDS SERVED`}</p></header>
    <section className="stat-grid"><div><small>SCORE</small><b className="amber">+{stats.score.toLocaleString()}</b></div><div><small>ACCURACY</small><b className="mint">{accuracy}%</b></div><div><small>BEST STREAK</small><b className="pink">×{stats.bestStreak}</b></div><div><small>WORDS SERVED</small><b className="cyan">{stats.seen.size}</b></div></section>
    <section className="review-ranking"><h2>MOST REINFORCEMENT NEEDED</h2>{ranking.length === 0
      ? <p>Perfect round — no struggles or misses.</p>
      : <div className="ranking-table">{ranking.map(([cardId, item], index) => {
        const word = wordMap.get(cardId);
        const errors = item.wrongPinyin + item.wrongMeaning + item.landed;
        const mastery = vocabByCard.get(cardId)?.mastery ?? 0;
        const category = masteryCategory(mastery, battleConfig);
        return <div key={cardId} className="ranking-row">
          <b>#{index + 1}</b><strong><HanziText text={word?.displayHanzi ?? cardId} data={strokeData} /></strong><span>{word?.displayPinyin}</span>
          <span>{errors} WRONG · {item.misses} {item.misses === 1 ? "MISS" : "MISSES"}</span>
          <em className={`mastery-chip is-${category}`}>{MASTERY_CHIP_LABEL[category]}</em>
          <em>{item.attempts > 0 ? `${(item.totalPinyinMs / item.attempts / 1000).toFixed(1)}s AVG` : "—"}</em>
        </div>;
      })}</div>
    }</section>
    <footer>
      <button onClick={onMenu}>RETURN TO MENU</button>
      <button className="mint-button" onClick={onNewBattle}>START NEW BATTLE</button>
    </footer>
    <div className="sr-only">{statusLabel(saveStatus)}</div>
  </main>;
}
