import type { PinyinSelectionView } from "../state/useBattle";

/** Selection Mode's pinyin answer UI. It follows the meaning-selection visual
 * language (paper-strip buttons in a 4×2 grid) but shows no hotkeys: buttons
 * answer by click/tap or the platform's normal Enter/Space activation only.
 *
 * `SelectedPinyin` sits above the buttons (displaced upward, like the typed
 * pinyin it replaces) and exposes the current-character progress both
 * visually and to assistive technology. */

export function SelectedPinyin({ selection }: { selection: PinyinSelectionView }) {
  const chosen = selection.selected.join(" ");
  return <div
    className="selected-pinyin"
    role="status"
    aria-live="polite"
    aria-label={`Selected pinyin ${chosen || "none"}. Character ${selection.charIndex + 1} of ${selection.charCount} (${selection.hanzi}).`}
  >
    <span className={`chosen ${chosen ? "" : "empty"}`} aria-hidden="true">{chosen || "—"}<i className="caret" /></span>
    <span className="char-progress" aria-hidden="true" lang="zh-Hans">
      {selection.hanziChars.map((character, index) => (
        <b key={index} className={index < selection.charIndex ? "done" : index === selection.charIndex ? "current" : ""}>
          {character}
        </b>
      ))}
    </span>
  </div>;
}

export function PinyinChoiceGrid({
  selection, disabled, onChoose, className = "",
}: {
  selection: PinyinSelectionView;
  disabled: boolean;
  onChoose: (label: string) => void;
  className?: string;
}) {
  return <div
    className={`pinyin-grid ${className}`.trim()}
    role="group"
    aria-label={`Pinyin choices for character ${selection.charIndex + 1} of ${selection.charCount} (${selection.hanzi})`}
  >
    {selection.labels.map((label) => (
      <button key={label} type="button" disabled={disabled} onClick={() => onChoose(label)}>
        <span className="pinyin-label">{label}</span>
      </button>
    ))}
  </div>;
}
