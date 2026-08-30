import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { BattleScene, type EnemyView } from "./BattleScene";

export function GameCanvas({ enemies, targetId }: { enemies: EnemyView[]; targetId: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<BattleScene | null>(null);
  const snapshot = useRef({ enemies, targetId });
  snapshot.current = { enemies, targetId };

  useEffect(() => {
    if (!host.current) return;
    const battle = new BattleScene();
    scene.current = battle;
    const game = new Phaser.Game({
      type: Phaser.AUTO, parent: host.current, width: 480, height: 210,
      pixelArt: true, antialias: false, roundPixels: true, backgroundColor: "#070A18",
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: 480, height: 210 },
      scene: battle, transparent: false,
      callbacks: { postBoot: () => battle.sync(snapshot.current.enemies, snapshot.current.targetId) },
    });
    return () => { scene.current = null; game.destroy(true); };
  }, []);

  useEffect(() => { scene.current?.sync(enemies, targetId); }, [enemies, targetId]);
  return <div className="game-canvas" ref={host} aria-hidden="true" />;
}
