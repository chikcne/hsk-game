import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Enemy } from "../../domain/session/types";
import { DANGER_ZONE_PROGRESS } from "../../shared/constants";
import type { RuntimeWord } from "../../shared/schemas";

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

function Phrase({ enemy, target, remnant = false }: { enemy: EnemyView; target: boolean; remnant?: boolean }) {
  return <div
    className={`calligraphy-phrase ${target ? "is-target" : ""} ${!remnant && enemy.progress > DANGER_ZONE_PROGRESS ? "is-danger" : ""} ${remnant ? "is-solved" : "is-writing"}`}
    style={phraseStyle(enemy)}
  >
    {[...enemy.word.displayHanzi].map((character, index) => <span key={`${character}-${index}`}>{character}</span>)}
    {target && !remnant && <b className="active-mark">当前</b>}
  </div>;
}

function SolvedPhrase({ item, reducedMotion, onDone }: { item: PhraseRemnant; reducedMotion: boolean; onDone: (key: string) => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDone(item.key), reducedMotion ? 150 : 620);
    return () => window.clearTimeout(timeout);
  }, [item.key, reducedMotion]);
  return <Phrase enemy={item.enemy} target={false} remnant />;
}

/**
 * The word field is DOM-owned so glyphs stay sharp at every device pixel
 * ratio. Encounter timing and progress still come directly from useBattle;
 * columns are a cosmetic projection of spawnOrdinal only.
 */
export function GameCanvas({ enemies, targetId, solvedId, reducedMotion = false }: { enemies: EnemyView[]; targetId: string | null; solvedId: string | null; reducedMotion?: boolean }) {
  const previous = useRef(new Map<string, EnemyView>());
  const [remnants, setRemnants] = useState<PhraseRemnant[]>([]);

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
  return <div className="calligraphy-field" aria-hidden="true">
    <div className="column-rules">
      {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
    </div>
    {target && <div className="target-column" style={phraseStyle(target)} />}
    {enemies.map((enemy) => <Phrase key={enemy.id} enemy={enemy} target={enemy.id === targetId} />)}
    {remnants.map((item) => <SolvedPhrase key={item.key} item={item} reducedMotion={reducedMotion} onDone={(key) => setRemnants((items) => items.filter((candidate) => candidate.key !== key))} />)}
    <div className="landing-rule"><span>落卷线</span></div>
  </div>;
}
