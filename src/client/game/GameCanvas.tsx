import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { BattleScene, type EnemyView } from "./BattleScene";

const ARENA_WIDTH = 480;
const ARENA_HEIGHT = 210;

type ArenaViewport = { left: number; top: number; width: number; height: number; scale: number };

export function GameCanvas({ enemies, targetId }: { enemies: EnemyView[]; targetId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<BattleScene | null>(null);
  const snapshot = useRef({ enemies, targetId });
  const [viewport, setViewport] = useState<ArenaViewport>({ left: 0, top: 0, width: 0, height: 0, scale: 1 });
  snapshot.current = { enemies, targetId };

  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const updateViewport = () => {
      const scale = Math.min(element.clientWidth / ARENA_WIDTH, element.clientHeight / ARENA_HEIGHT);
      const width = ARENA_WIDTH * scale;
      const height = ARENA_HEIGHT * scale;
      setViewport({ left: (element.clientWidth - width) / 2, top: (element.clientHeight - height) / 2, width, height, scale });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);

    const battle = new BattleScene();
    scene.current = battle;
    const game = new Phaser.Game({
      type: Phaser.AUTO, parent: element, width: ARENA_WIDTH, height: ARENA_HEIGHT,
      pixelArt: true, antialias: false, roundPixels: true, backgroundColor: "#070A18",
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: ARENA_WIDTH, height: ARENA_HEIGHT },
      scene: battle, transparent: false,
      callbacks: { postBoot: () => battle.sync(snapshot.current.enemies, snapshot.current.targetId) },
    });
    return () => { observer.disconnect(); scene.current = null; game.destroy(true); };
  }, []);

  useEffect(() => { scene.current?.sync(enemies, targetId); }, [enemies, targetId]);
  return <div className="game-canvas" ref={host} aria-hidden="true">
    <div className="hanzi-overlay" style={{ left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height }}>
      {enemies.map((enemy) => {
        const textSize = enemy.word.displayHanzi.length <= 2 ? 22 : enemy.word.displayHanzi.length <= 4 ? 16 : 12;
        return <span
          className="hanzi-glyph"
          lang="zh-Hans"
          key={enemy.id}
          style={{
            left: (35 + enemy.lane * (410 / 7)) * viewport.scale,
            top: (18 + enemy.progress * 145) * viewport.scale,
            fontSize: textSize * viewport.scale,
          }}
        >{enemy.word.displayHanzi}</span>;
      })}
    </div>
  </div>;
}
