import type { StrokeDataMap } from "../data/strokeData";

const HAN_CHARACTER = /^\p{Script=Han}$/u;

type Props = {
  text: string;
  data: StrokeDataMap;
  className?: string;
  vertical?: boolean;
  /** Set false when an ancestor already hides this decorative copy. */
  accessible?: boolean;
};

/** Renders Make Me a Hanzi outlines directly, without creating an imperative
 * Hanzi Writer instance for static labels. Visually hidden semantic text stays
 * available to assistive technology while the SVG paths remain decorative. */
export function HanziText({ text, data, className = "", vertical = false, accessible = true }: Props) {
  const units: Array<{ han: boolean; text: string }> = [];
  for (const character of text) {
    const han = HAN_CHARACTER.test(character);
    const previous = units.at(-1);
    if (!han && previous && !previous.han) previous.text += character;
    else units.push({ han, text: character });
  }
  return <span
    className={`vector-text ${vertical ? "vector-text-vertical" : ""} ${className}`.trim()}
    lang="zh-Hans"
    aria-hidden={accessible ? undefined : true}
  >
    {accessible && <span className="vector-text-accessible">{text}</span>}
    <span className="vector-text-visual" aria-hidden="true">
      {units.map((unit, index) => {
      if (!unit.han) return <span aria-hidden="true" className="vector-text-literal" key={index}>{unit.text}</span>;
      const character = unit.text;
      const characterData = data.get(character);
      if (!characterData) return <span aria-hidden="true" className="hanzi-glyph hanzi-glyph-missing" key={index} />;
      return <svg
        aria-hidden="true"
        className="hanzi-glyph"
        focusable="false"
        key={index}
        viewBox="0 0 1024 1024"
      >
        <g transform="translate(0 900) scale(1 -1)">
          {characterData.strokes.map((path, strokeIndex) => <path d={path} key={strokeIndex} />)}
        </g>
      </svg>;
      })}
    </span>
  </span>;
}
