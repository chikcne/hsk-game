import { sanitizeText } from "./text";

export function canonicalizePinyin(input: string): string {
  const normalized = sanitizeText(input).normalize("NFKC").toLowerCase().replace(/u:/gu, "v").normalize("NFD");
  let output = "";
  let lastWasU = false;
  for (const character of normalized) {
    if (/^[a-z]$/u.test(character)) {
      output += character;
      lastWasU = character === "u";
    } else if (character === "\u0308" && lastWasU && output.endsWith("u")) {
      output = `${output.slice(0, -1)}v`;
      lastWasU = false;
    } else if (!/^\p{M}$/u.test(character)) {
      lastWasU = false;
    }
  }
  return output;
}

export function acceptedPinyinForms(displayPinyin: string): string[] {
  const forms = displayPinyin.split("/").map(canonicalizePinyin).filter(Boolean);
  return [...new Set(forms)].sort((a, b) => a.localeCompare(b));
}
