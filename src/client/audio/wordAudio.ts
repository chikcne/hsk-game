import { Context, Data, Effect, Layer } from "effect";
import { runPromiseWithTypedError } from "../../shared/effect-runtime";
import type { RuntimeWord } from "../../shared/schemas";

export type AudioFactory = (source: string) => HTMLAudioElement;

export function wordAudioSource(deckId: string, word: RuntimeWord): string {
  if (!word.audioUrl) return "";
  return word.audioUrl.startsWith("/") ? word.audioUrl : `/game-data/${deckId}/${word.audioUrl}`;
}

/** Visible failure: audio.play() rejected for a source the card should sound.
 * Consumers (useCardAudio) surface this as the card's audio error flag. */
export class WordAudioPlayError extends Data.TaggedError("WordAudioPlayError")<{
  readonly source: string;
  readonly cause: Error;
}> {}

/** Silent failure: the preload load() hint failed; playback reports the
 * actionable error later if the asset is actually used. */
export class WordAudioLoadError extends Data.TaggedError("WordAudioLoadError")<{
  readonly source: string;
  readonly cause: Error;
}> {}

/** Silent failure: discarding a pooled element during dispose is harmless. */
export class WordAudioDisposeError extends Data.TaggedError("WordAudioDisposeError")<{
  readonly cause: Error;
}> {}

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export interface WordAudioServiceShape {
  readonly preload: (sources: Iterable<string>) => void;
  readonly playEffect: (
    source: string,
    volume: number,
  ) => Effect.Effect<void, WordAudioPlayError, never>;
  readonly dispose: () => void;
}

export class WordAudioService extends Context.Tag("WordAudioService")<
  WordAudioService,
  WordAudioServiceShape
>() {}

const clampVolume = (volume: number): number => Math.max(0, Math.min(1, volume));

const preloadElement = (
  audio: HTMLAudioElement,
  source: string,
): Effect.Effect<void, WordAudioLoadError, never> =>
  Effect.try({
    try: () => audio.load(),
    catch: (cause) => new WordAudioLoadError({ source, cause: normalizeError(cause) }),
  });

const primePlayback = (
  audio: HTMLAudioElement,
  source: string,
  volume: number,
): Effect.Effect<void, WordAudioPlayError, never> => Effect.gen(function* () {
  yield* Effect.try({
    try: () => { audio.volume = clampVolume(volume); },
    catch: (cause) => new WordAudioPlayError({ source, cause: normalizeError(cause) }),
  });
  // Metadata may not be available yet; play() will start at the beginning.
  yield* Effect.ignore(Effect.try({
    try: () => { audio.currentTime = 0; },
    catch: (cause) => new WordAudioPlayError({ source, cause: normalizeError(cause) }),
  }));
});

const startPlayback = (
  audio: HTMLAudioElement,
  source: string,
): Effect.Effect<void, WordAudioPlayError, never> => Effect.tryPromise({
  try: () => audio.play(),
  catch: (cause) => new WordAudioPlayError({ source, cause: normalizeError(cause) }),
});

const discardElement = (
  audio: HTMLAudioElement,
): Effect.Effect<void, WordAudioDisposeError, never> => Effect.try({
  try: () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  },
  catch: (cause) => new WordAudioDisposeError({ cause: normalizeError(cause) }),
});

/** Keeps one media element per word-audio asset so loading can begin when a
 * word enters the scheduling pool rather than when the player answers it.
 * All Audio API access is wrapped in Effect; the class keeps its Promise
 * `play` for compatibility, with the typed error as the rejection value. */
export class WordAudioPlayer implements WordAudioServiceShape {
  private readonly players = new Map<string, HTMLAudioElement>();

  constructor(private readonly createAudio: AudioFactory = (source) => new Audio(source)) {}

  preload(sources: Iterable<string>): void {
    for (const source of sources) {
      if (!source || this.players.has(source)) continue;
      const audio = this.createAudio(source);
      audio.preload = "auto";
      this.players.set(source, audio);
      // Audio preload is a browser hint; load() makes the request start now.
      Effect.runSync(Effect.ignore(preloadElement(audio, source)));
    }
  }

  private pooled(source: string): HTMLAudioElement | undefined {
    if (!source) return undefined;
    this.preload([source]);
    return this.players.get(source);
  }

  playEffect(source: string, volume: number): Effect.Effect<void, WordAudioPlayError, never> {
    const audio = this.pooled(source);
    if (!audio) return Effect.void;
    return Effect.gen(function* () {
      yield* primePlayback(audio, source, volume);
      yield* startPlayback(audio, source);
    });
  }

  play(source: string, volume: number): Promise<void> {
    return runPromiseWithTypedError(this.playEffect(source, volume));
  }

  dispose(): void {
    for (const audio of this.players.values()) {
      Effect.runSync(Effect.ignore(discardElement(audio)));
    }
    this.players.clear();
  }
}

export const layerWordAudioService: Layer.Layer<WordAudioService> = Layer.sync(
  WordAudioService,
  () => new WordAudioPlayer(),
);
