import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Exit } from "effect";
import { WordAudioPlayer } from "../audio/wordAudio";

/** Pure guard for the play-rejection handler: a player that is no longer
 * the hook's current player was disposed (React StrictMode mounts, mounts,
 * then unmounts its first effect; every remount disposes the previous
 * player while its play() promise is still in flight). Such stale
 * rejections must NOT flag the live card's audio as errored. */
export function isStaleAudioPlayer(current: WordAudioPlayer | null, failing: WordAudioPlayer): boolean {
  return current !== failing;
}

/** Plays a word's local audio when the card appears and exposes a replay.
 * A missing source is inert; playback failures (for example an autoplay
 * policy before the first user gesture) surface as an error flag while the
 * replay button stays available for another try. Volume changes apply on the
 * next play instead of restarting the current card.
 *
 * The playback program is Effect-native (`WordAudioPlayer.playEffect`) and
 * only forks at this hook boundary; the Exit observer applies the same
 * stale-player semantics the promise-catch handler used to. */
export function useCardAudio(source: string, volume = 1): { replay: () => void; error: boolean } {
  const playerRef = useRef<WordAudioPlayer | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = Math.max(0, Math.min(1, volume));
  const [error, setError] = useState(false);

  useEffect(() => {
    const player = new WordAudioPlayer();
    playerRef.current = player;
    return () => {
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, []);

  const play = useCallback(() => {
    const player = playerRef.current;
    if (!player || !source) return;
    setError(false);
    // Hook/event compatibility boundary: the typed Effect workflow ends here.
    Effect.runFork(player.playEffect(source, volumeRef.current).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!Exit.isFailure(exit)) return;
          // StrictMode's discarded first player rejects after disposal; only a
          // failure from the CURRENT player is a real, surfaceable error.
          if (isStaleAudioPlayer(playerRef.current, player)) return;
          setError(true);
        }),
      ),
    ));
  }, [source]);

  useEffect(() => {
    if (!source) return;
    play();
  }, [play, source]);

  return { replay: play, error };
}
