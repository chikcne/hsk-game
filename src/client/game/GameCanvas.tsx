import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Enemy } from "../../domain/session/types";
import { DANGER_ZONE_PROGRESS } from "../../shared/constants";
import type { RuntimeWord } from "../../shared/schemas";
import { STROKE_CADENCE_MS, type StrokeDataMap } from "../data/strokeData";
import { HanziText } from "./HanziText";
import { StrokeOrderCharacter } from "./StrokeOrderCharacter";

export type EnemyView = Enemy & { word: RuntimeWord };

type PhraseRemnant = {
  key: string;
  enemy: EnemyView;
};

type PhraseStyle = CSSProperties & {
  "--desktop-x": string;
  "--mobile-x": string;
  "--phrase-y": string;
  "--phrase-progress": number;
  "--overlap-offset": string;
};

const phraseStyle = (enemy: EnemyView): PhraseStyle => {
  const desktopColumn = 12 - 1 - (enemy.spawnOrdinal % 12);
  const mobileColumn = 6 - 1 - (enemy.spawnOrdinal % 6);
  const progress = Math.min(1, Math.max(0, enemy.progress));
  return {
    "--desktop-x": `${((desktopColumn + 0.5) / 12) * 100}%`,
    "--mobile-x": `${((mobileColumn + 0.5) / 6) * 100}%`,
    "--phrase-y": `${2 + progress * 94}%`,
    "--phrase-progress": progress,
    "--overlap-offset": `${enemy.spawnOrdinal % 2 === 0 ? -2 : 2}px`,
  };
};

function Phrase({ enemy, target, preparing = false, remnant = false, reducedMotion, paused, strokeData }: {
  enemy: EnemyView;
  target: boolean;
  preparing?: boolean;
  remnant?: boolean;
  reducedMotion: boolean;
  paused: boolean;
  strokeData: StrokeDataMap;
}) {
  let elapsedStrokeMs = 0;
  const characters = [...enemy.word.displayHanzi].map((character, index) => {
    const data = strokeData.get(character);
    const startDelayMs = elapsedStrokeMs;
    elapsedStrokeMs += (data?.strokes.length ?? 0) * STROKE_CADENCE_MS;
    return <StrokeOrderCharacter
      key={`${enemy.id}-${index}`}
      character={character}
      data={data}
      // Writing belongs exclusively to the pre-spawn phase. Switching this
      // off at gameplay spawn also makes any reconciliation remount render the
      // completed glyph instead of replaying its strokes.
      animate={preparing && !reducedMotion}
      startDelayMs={startDelayMs}
      paused={paused}
      ink={remnant ? "solved" : target ? "target" : "ink"}
    />;
  });
  return <div
    className={`calligraphy-phrase ${target ? "is-target" : ""} ${preparing ? "is-preparing" : ""} ${!preparing && !remnant && enemy.progress > DANGER_ZONE_PROGRESS ? "is-danger" : ""} ${remnant ? "is-solved" : "is-writing"}`}
    style={phraseStyle(enemy)}
  >
    {!preparing && enemy.isNewWord && <b className="new-word-mark"><HanziText text="新" data={strokeData} accessible={false} /></b>}
    {!preparing && !remnant && enemy.progress > DANGER_ZONE_PROGRESS && <b className="danger-mark"><HanziText text="次" data={strokeData} accessible={false} /></b>}
    {characters}
  </div>;
}

function SolvedPhrase({ item, reducedMotion, strokeData, onDone }: {
  item: PhraseRemnant;
  reducedMotion: boolean;
  strokeData: StrokeDataMap;
  onDone: (key: string) => void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDone(item.key), reducedMotion ? 150 : 620);
    return () => window.clearTimeout(timeout);
  }, [item.key, reducedMotion]);
  return <Phrase enemy={item.enemy} target={false} remnant reducedMotion={reducedMotion} paused={false} strokeData={strokeData} />;
}

/**
 * The word field is DOM-owned so glyphs stay sharp at every device pixel
 * ratio. Encounter timing and progress still come directly from useBattle;
 * columns are a cosmetic projection of spawnOrdinal only.
 */
export function GameCanvas({ enemies, preparingEnemy, targetId, solvedId, strokeData, paused = false, reducedMotion = false }: {
  enemies: EnemyView[];
  preparingEnemy: EnemyView | null;
  targetId: string | null;
  solvedId: string | null;
  strokeData: StrokeDataMap;
  paused?: boolean;
  reducedMotion?: boolean;
}) {
  const previous = useRef(new Map<string, EnemyView>());
  const [remnants, setRemnants] = useState<PhraseRemnant[]>([]);
  const [pageHidden, setPageHidden] = useState(() => typeof document !== "undefined" && document.hidden);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const live = new Set(enemies.map((enemy) => enemy.id));
    const solvedEnemy = solvedId ? previous.current.get(solvedId) : undefined;
    if (solvedEnemy && !live.has(solvedEnemy.id)) {
      const key = `${solvedEnemy.id}-${performance.now()}`;
      setRemnants((items) => [...items, { key, enemy: solvedEnemy }]);
      previous.current = new Map(enemies.map((enemy) => [enemy.id, enemy]));
      return;
    }
    previous.current = new Map(enemies.map((enemy) => [enemy.id, enemy]));
  }, [enemies, solvedId]);

  const target = enemies.find((enemy) => enemy.id === targetId);
  const visualEnemies = preparingEnemy && !enemies.some((enemy) => enemy.id === preparingEnemy.id)
    ? [preparingEnemy, ...enemies]
    : enemies;
  return <div className="calligraphy-field" aria-hidden="true">
    <div className="column-rules">
      {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
    </div>
    <div className="calligraphy-contents">
      {target && <div className="target-column" style={phraseStyle(target)} />}
      {visualEnemies.map((enemy) => <Phrase
        key={enemy.id} enemy={enemy} target={enemy.id === targetId}
        preparing={enemy.id === preparingEnemy?.id}
        reducedMotion={reducedMotion} paused={paused || pageHidden} strokeData={strokeData}
      />)}
      {remnants.map((item) => <SolvedPhrase
        key={item.key} item={item} reducedMotion={reducedMotion} strokeData={strokeData}
        onDone={(key) => setRemnants((items) => items.filter((candidate) => candidate.key !== key))}
      />)}
    </div>
    <div className="landing-rule" />
  </div>;
}
