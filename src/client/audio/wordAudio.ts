import type { LevelProgress, RuntimeWord } from "../../shared/schemas";

export type AudioFactory = (source: string) => HTMLAudioElement;

export const AUDIO_POOL_LOOKAHEAD = 3;

/** Includes already introduced cards plus the next curriculum cards that will
 * enter the pool, giving their audio a full level of gameplay to load. */
export function audioPoolWordIds(
  level: LevelProgress,
  curriculumIds: readonly string[],
  lookahead = AUDIO_POOL_LOOKAHEAD,
): string[] {
  const ids = new Set(Object.entries(level.words)
    .filter(([, progress]) => progress.introducedAtOrdinal !== null)
    .map(([id]) => id));
  for (const id of curriculumIds.slice(level.curriculumCursor, level.curriculumCursor + lookahead)) ids.add(id);
  return [...ids];
}

export function wordAudioSource(deckId: string, word: RuntimeWord): string {
  if (!word.audioUrl) return "";
  return word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deckId}/${word.audioUrl}`;
}

/** Keeps one media element per word-audio asset so loading can begin when a
 * word enters the scheduling pool rather than when the player answers it. */
export class WordAudioPlayer {
  private readonly players = new Map<string, HTMLAudioElement>();

  constructor(private readonly createAudio: AudioFactory = (source) => new Audio(source)) {}

  preload(sources: Iterable<string>): void {
    for (const source of sources) {
      if (!source || this.players.has(source)) continue;
      const audio = this.createAudio(source);
      audio.preload = "auto";
      this.players.set(source, audio);
      // Audio preload is a browser hint; load() makes the request start now.
      try {
        audio.load();
      } catch {
        // Playback reports the actionable error if the asset is later used.
      }
    }
  }

  async play(source: string, volume: number): Promise<void> {
    if (!source) return;
    this.preload([source]);
    const audio = this.players.get(source);
    if (!audio) return;
    audio.volume = Math.max(0, Math.min(1, volume));
    try {
      audio.currentTime = 0;
    } catch {
      // Metadata may not be available yet; play() will start at the beginning.
    }
    await audio.play();
  }

  dispose(): void {
    for (const audio of this.players.values()) {
      audio.pause();
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {
        // The element is being discarded, so cleanup failures are harmless.
      }
    }
    this.players.clear();
  }
}
