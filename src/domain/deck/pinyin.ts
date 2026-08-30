export function canonicalizePinyin(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase().trim().replace(/u:/g, "v").normalize("NFD");
  let result = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "u" && normalized[index + 1] === "\u0308") {
      result += "v";
      index += 1;
      continue;
    }
    if (/[a-zv]/.test(character)) result += character;
  }
  return result;
}

export function acceptsPinyin(accepted: readonly string[], raw: string): boolean {
  const answer = canonicalizePinyin(raw);
  return answer.length > 0 && accepted.includes(answer);
}
