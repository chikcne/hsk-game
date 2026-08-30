import { describe, expect, it, vi } from "vitest";
import { audioPoolWordIds, WordAudioPlayer, wordAudioSource } from "../../src/client/audio/wordAudio";
import type { LevelProgress, RuntimeWord } from "../../src/shared/schemas";

function fakeWord(audioUrl: string): RuntimeWord {
  return {
    id: "word-1",
    sourceGuids: [],
    displayHanzi: "字",
    hanziKey: "字",
    displayPinyin: "zì",
    acceptedPinyin: ["zi"],
    partOfSpeech: null,
    partOfSpeechKey: null,
    senseLabel: null,
    meaning: "character",
    meaningKey: "character",
    example: null,
    audioUrl,
  };
}

describe("WordAudioPlayer", () => {
  it("includes the next three curriculum words beyond the introduced pool", () => {
    const level = {
      curriculumCursor: 2,
      words: {
        first: { introducedAtOrdinal: 0 },
        second: { introducedAtOrdinal: 0 },
        third: { introducedAtOrdinal: null },
        fourth: { introducedAtOrdinal: null },
        fifth: { introducedAtOrdinal: null },
        sixth: { introducedAtOrdinal: null },
      },
    } as unknown as LevelProgress;

    expect(audioPoolWordIds(level, ["first", "second", "third", "fourth", "fifth", "sixth"]))
      .toEqual(["first", "second", "third", "fourth", "fifth"]);
  });

  it("starts loading each pooled asset once and reuses it for playback", async () => {
    const load = vi.fn();
    const play = vi.fn(async () => undefined);
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    const created: Array<{ source: string; audio: HTMLAudioElement }> = [];
    const player = new WordAudioPlayer((source) => {
      const audio = {
        preload: "none",
        volume: 1,
        currentTime: 12,
        load,
        play,
        pause,
        removeAttribute,
      } as unknown as HTMLAudioElement;
      created.push({ source, audio });
      return audio;
    });

    player.preload(["/word.mp3", "/word.mp3"]);

    expect(created).toHaveLength(1);
    expect(created[0]?.source).toBe("/word.mp3");
    expect(created[0]?.audio.preload).toBe("auto");
    expect(load).toHaveBeenCalledTimes(1);

    await player.play("/word.mp3", 0.4);

    expect(created).toHaveLength(1);
    expect(created[0]?.audio.volume).toBe(0.4);
    expect(created[0]?.audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);

    player.dispose();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(removeAttribute).toHaveBeenCalledWith("src");
  });

  it("resolves deck-relative and already absolute audio URLs", () => {
    expect(wordAudioSource("hsk-3", fakeWord("audio/hash.mp3"))).toBe("/game-data/hsk-3/audio/hash.mp3");
    expect(wordAudioSource("hsk-3", fakeWord("/game-data/hsk-1/audio/hash.mp3"))).toBe("/game-data/hsk-1/audio/hash.mp3");
    expect(wordAudioSource("hsk-3", fakeWord(""))).toBe("");
  });
});
