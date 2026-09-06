/** Pure pinyin-selection progress for one locked enemy.
 *
 * Selection Mode answers the pinyin phase one Han character at a time: a
 * correct click appends that character's segment and advances; the final
 * character's correct click completes the word (the caller then enters the
 * meaning phase exactly as a correctly typed pinyin would); a wrong click
 * resolves immediately as `wrongPinyin`. The reducer holds no clocks and no
 * React state — `useBattle` resets it whenever the locked target changes and
 * feeds it every click. */

export type PinyinSelectionProgress = {
  /** Segments already confirmed, one per completed character. */
  selected: string[];
  /** Index of the Han character currently being answered. */
  charIndex: number;
};

export const initialPinyinSelection = (): PinyinSelectionProgress => ({ selected: [], charIndex: 0 });

export type PinyinSelectionStep =
  | { kind: "advance"; progress: PinyinSelectionProgress }
  | { kind: "complete"; progress: PinyinSelectionProgress }
  | { kind: "wrong"; attempted: string; progress: PinyinSelectionProgress };

/** Applies one clicked label against the word's character-aligned segments.
 * Any authored alternative of the current character counts as the correct
 * selection (the generator only ever shows the first as a button). */
export function applyPinyinSelection(
  segments: readonly (readonly string[])[],
  progress: PinyinSelectionProgress,
  label: string,
): PinyinSelectionStep {
  const alternatives = segments[progress.charIndex] ?? [];
  const groupedLabel = alternatives.join(" / ");
  if (!alternatives.includes(label) && label !== groupedLabel) {
    return { kind: "wrong", attempted: [...progress.selected, label].join(""), progress };
  }
  const next: PinyinSelectionProgress = {
    selected: [...progress.selected, label],
    charIndex: progress.charIndex + 1,
  };
  return next.charIndex >= segments.length
    ? { kind: "complete", progress: next }
    : { kind: "advance", progress: next };
}
