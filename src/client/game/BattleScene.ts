import Phaser from "phaser";
import type { Enemy } from "../../domain/session/types";
import type { RuntimeWord } from "../../shared/schemas";

export type EnemyView = Enemy & { word: RuntimeWord };
type ShipParts = { root: Phaser.GameObjects.Container; screen: Phaser.GameObjects.Rectangle; body: Phaser.GameObjects.Rectangle; target: Phaser.GameObjects.Rectangle };

export class BattleScene extends Phaser.Scene {
  private ships = new Map<string, ShipParts>();
  private current: EnemyView[] = [];
  private targetId: string | null = null;

  constructor() { super("battle"); }
  create() {
    this.cameras.main.setBackgroundColor("#070a18");
    const graphics = this.add.graphics();
    graphics.fillStyle(0x55e6ff, 0.8);
    const random = new Phaser.Math.RandomDataGenerator(["hanzi-stars"]);
    for (let index = 0; index < 70; index += 1) {
      const palette = [0x55e6ff, 0xff5ca8, 0xf4f0ff, 0x8391be];
      graphics.fillStyle(palette[index % palette.length]!, random.realInRange(0.45, 1));
      graphics.fillRect(random.between(2, 478), random.between(2, 183), random.pick([1, 1, 1, 2]), 1);
    }
    graphics.fillStyle(0x2b3f70, 1).fillRect(0, 188, 480, 22);
    for (let x = 6; x < 480; x += 24) graphics.fillStyle(0x17254a, 1).fillRect(x, 181, 14, 9);
    graphics.fillStyle(0xffc857, 1).fillRect(231, 183, 18, 17).fillStyle(0xff5ca8, 1).fillRect(224, 200, 32, 5).fillStyle(0xf4f0ff, 1).fillRect(238, 175, 6, 11);
    this.scale.on("resize", () => this.renderSnapshot());
    this.renderSnapshot();
  }

  sync(enemies: EnemyView[], targetId: string | null) {
    this.current = enemies;
    this.targetId = targetId;
    if (this.sys.isActive()) this.renderSnapshot();
  }

  private makeShip(enemy: EnemyView): ShipParts {
    const root = this.add.container(0, 0);
    const textSize = enemy.word.displayHanzi.length <= 2 ? 22 : enemy.word.displayHanzi.length <= 4 ? 16 : 12;
    const width = Math.max(36, Math.min(80, 16 + enemy.word.displayHanzi.length * textSize));
    const screen = this.add.rectangle(0, -8, width, 31, 0x101a36).setStrokeStyle(1.5, 0x55e6ff);
    const body = this.add.rectangle(0, 12, width + 10, 8, 0x55e6ff);
    const leftFoot = this.add.rectangle(-width / 3, 19, 8, 8, 0x55e6ff);
    const rightFoot = this.add.rectangle(width / 3, 19, 8, 8, 0x55e6ff);
    const target = this.add.rectangle(0, 1, width + 22, 56).setStrokeStyle(2, 0xffc857).setFillStyle(0, 0).setVisible(false);
    root.add([target, screen, body, leftFoot, rightFoot]);
    this.ships.set(enemy.id, { root, screen, body, target });
    return this.ships.get(enemy.id)!;
  }

  private renderSnapshot() {
    if (!this.add) return;
    const liveIds = new Set(this.current.map((enemy) => enemy.id));
    for (const [id, parts] of this.ships) if (!liveIds.has(id)) { parts.root.destroy(true); this.ships.delete(id); }
    for (const enemy of this.current) {
      const parts = this.ships.get(enemy.id) ?? this.makeShip(enemy);
      const active = enemy.id === this.targetId;
      const x = 35 + enemy.lane * (410 / 7);
      const y = 26 + enemy.progress * 145;
      parts.root.setPosition(x, y);
      const color = active ? 0xff5ca8 : enemy.progress > 0.8 ? 0xff5b6e : 0x55e6ff;
      parts.body.setFillStyle(color); parts.screen.setStrokeStyle(1.5, color); parts.target.setVisible(active);
    }
  }
}
