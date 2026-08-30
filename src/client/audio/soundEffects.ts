export type SoundEffect = "blaster" | "buzzer";

const SOUND_EFFECT_URLS: Record<SoundEffect, string> = {
  blaster: "/audio/blaster.m4a",
  buzzer: "/audio/buzzer.m4a",
};

let players: Partial<Record<SoundEffect, HTMLAudioElement>> = {};

function getPlayer(effect: SoundEffect): HTMLAudioElement {
  const existing = players[effect];
  if (existing) return existing;
  const audio = new Audio(SOUND_EFFECT_URLS[effect]);
  audio.preload = "auto";
  players[effect] = audio;
  return audio;
}

export function unlockSoundEffects(): void {
  for (const effect of Object.keys(SOUND_EFFECT_URLS) as SoundEffect[]) {
    const audio = getPlayer(effect);
    audio.muted = true;
    const started = audio.play();
    void started.then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    }).catch(() => {
      audio.muted = false;
    });
  }
}

export function playSoundEffect(effect: SoundEffect, volume: number): void {
  if (volume <= 0) return;
  const audio = getPlayer(effect);
  audio.muted = false;
  audio.volume = Math.max(0, Math.min(1, volume));
  audio.currentTime = 0;
  void audio.play().catch(() => {
    // Browsers may reject audio before the first user interaction.
  });
}
