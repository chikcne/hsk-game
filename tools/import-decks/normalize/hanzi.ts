import { sanitizeText } from "./text";

export type NormalizedHanzi = {
  displayHanzi: string;
  hanziKey: string;
  senseLabel: string | null;
  qualifierStyle: "parenthetical" | "numbered" | null;
  nfkcChanged: boolean;
};

export function normalizeHanzi(input: string): NormalizedHanzi {
  const sanitized = sanitizeText(input);
  let value = sanitized.normalize("NFKC").trim();
  const nfkcChanged = value !== sanitized;
  value = value.replace(/\.\s*$/u, "").trim();

  let senseLabel: string | null = null;
  let qualifierStyle: NormalizedHanzi["qualifierStyle"] = null;
  const qualifier = /\s*\(([^()]+)\)\s*$/u.exec(value);
  if (qualifier) {
    senseLabel = sanitizeText(qualifier[1]!);
    qualifierStyle = "parenthetical";
    value = value.slice(0, qualifier.index).trim();
  } else {
    const numbered = /(?<=\p{Unified_Ideograph}|〇)\s*([12])\s*$/u.exec(value);
    if (numbered) {
      senseLabel = `sense ${numbered[1]}`;
      qualifierStyle = "numbered";
      value = value.slice(0, numbered.index).trim();
    }
  }

  if (!value) throw new Error(`Hanzi is empty after normalization: ${JSON.stringify(input)}`);
  if (![...value].every((character) => /^(?:\p{Unified_Ideograph}|〇|·)$/u.test(character))) {
    throw new Error(`Unexpected non-CJK residue in Hanzi ${JSON.stringify(input)} -> ${JSON.stringify(value)}`);
  }
  return { displayHanzi: value.normalize("NFC"), hanziKey: value.normalize("NFKC"), senseLabel, qualifierStyle, nfkcChanged };
}
