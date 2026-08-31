import Phaser from "phaser";
import type { Enemy } from "../../domain/session/types";
import type { RuntimeWord } from "../../shared/schemas";

export type EnemyView = Enemy & { word: RuntimeWord };

/**
 * Phaser no longer rasterizes Hanzi or owns encounter layout. The production
 * field is rendered in semantic-adjacent DOM by GameCanvas so the CJK font
 * remains crisp. This scene is retained as the home for future paper/ink
 * particle effects; it deliberately has no targetable game objects.
 */
export class BattleScene extends Phaser.Scene {
  constructor() { super("battle-effects"); }

  create() {
    this.cameras.main.setBackgroundColor("rgba(0,0,0,0)");
  }
}
