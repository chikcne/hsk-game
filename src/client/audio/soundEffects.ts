import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";

export type SoundEffect = "blaster" | "buzzer";

const SOUND_EFFECT_URLS: Record<SoundEffect, string> = {
  blaster: "/audio/blaster.m4a",
  buzzer: "/audio/buzzer.m4a",
};

const ALL_SOUND_EFFECTS: readonly SoundEffect[] = Object.keys(SOUND_EFFECT_URLS) as SoundEffect[];

/** Visible failure: a real (audible) sound effect could not be primed or
 * started. Typed so callers could surface it deliberately; the fire-and-forget
 * boundary below keeps today's silent swallow. */
export class SoundEffectPlayError extends Data.TaggedError("SoundEffectPlayError")<{
  readonly effect: SoundEffect;
  readonly cause: Error;
}> {}

/** Silent failure: the muted autoplay-unlock probe was rejected — expected
 * before the first user gesture. Never surfaced; the element is just un-muted. */
export class SoundEffectUnlockError extends Data.TaggedError("SoundEffectUnlockError")<{
  readonly effect: SoundEffect;
  readonly cause: Error;
}> {}

const normalizeError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export interface SoundEffectsServiceShape {
  /** Best-effort muted playback of every pooled element so browsers grant
   * autoplay after the first user gesture. All failures are silent. */
  readonly unlockEffect: Effect.Effect<void, never, never>;
  /** Plays a pooled effect at a volume; a typed failure if it cannot start. */
  readonly playEffect: (
    effect: SoundEffect,
    volume: number,
  ) => Effect.Effect<void, SoundEffectPlayError, never>;
}

export class SoundEffectsService extends Context.Tag("SoundEffectsService")<
  SoundEffectsService,
  SoundEffectsServiceShape
>() {}

const clampVolume = (volume: number): number => Math.max(0, Math.min(1, volume));

function makeSoundEffectsService(): SoundEffectsServiceShape {
  // One media element per effect, created lazily and pooled forever.
  const players: Partial<Record<SoundEffect, HTMLAudioElement>> = {};

  const getPlayer = (effect: SoundEffect): HTMLAudioElement => {
    const existing = players[effect];
    if (existing) return existing;
    const audio = new Audio(SOUND_EFFECT_URLS[effect]);
    audio.preload = "auto";
    players[effect] = audio;
    return audio;
  };

  const primeElement = (
    audio: HTMLAudioElement,
    effect: SoundEffect,
    volume: number,
  ): Effect.Effect<void, SoundEffectPlayError, never> =>
    Effect.try({
      try: () => {
        audio.muted = false;
        audio.volume = clampVolume(volume);
        audio.currentTime = 0;
      },
      catch: (cause) => new SoundEffectPlayError({ effect, cause: normalizeError(cause) }),
    });

  const startElement = (
    audio: HTMLAudioElement,
    effect: SoundEffect,
  ): Effect.Effect<void, SoundEffectPlayError, never> => Effect.tryPromise({
    try: () => audio.play(),
    catch: (cause) => new SoundEffectPlayError({ effect, cause: normalizeError(cause) }),
  });

  const unlockOne = (effect: SoundEffect): Effect.Effect<void, never, never> => {
    const audio = getPlayer(effect);
    return Effect.gen(function* () {
      audio.muted = true;
      yield* Effect.tryPromise({
        try: () => audio.play(),
        catch: (cause) => new SoundEffectUnlockError({ effect, cause: normalizeError(cause) }),
      });
      yield* Effect.try({
        try: () => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        },
        catch: (cause) => new SoundEffectUnlockError({ effect, cause: normalizeError(cause) }),
      });
    }).pipe(
      // Unlock is silent by contract: a rejection (autoplay policy) only un-mutes.
      Effect.catchAll(() => Effect.sync(() => {
        audio.muted = false;
      })),
    );
  };

  return {
    unlockEffect: Effect.forEach(ALL_SOUND_EFFECTS, unlockOne, {
      discard: true,
      concurrency: "unbounded",
    }),
    playEffect: (effect, volume) =>
      volume <= 0
        ? Effect.void
        : Effect.gen(function* () {
            const audio = getPlayer(effect);
            yield* primeElement(audio, effect, volume);
            yield* startElement(audio, effect);
          }),
  };
}

export const layerSoundEffectsService: Layer.Layer<SoundEffectsService> = Layer.sync(
  SoundEffectsService,
  makeSoundEffectsService,
);

/** Compatibility boundary: the module-level runtime turns Effect programs into
 * fire-and-forget browser calls from plain (synchronous) event handlers. */
const runtime = ManagedRuntime.make(layerSoundEffectsService);

export function unlockSoundEffects(): void {
  runtime.runFork(
    Effect.flatMap(SoundEffectsService, (service) => service.unlockEffect).pipe(Effect.ignore),
  );
}

export function playSoundEffect(effect: SoundEffect, volume: number): void {
  if (volume <= 0) return;
  runtime.runFork(
    Effect.flatMap(SoundEffectsService, (service) => service.playEffect(effect, volume)).pipe(
      // Browsers may reject audio before the first user interaction; this
      // boundary stays fire-and-forget, exactly as before the refactor.
      Effect.ignore,
    ),
  );
}
