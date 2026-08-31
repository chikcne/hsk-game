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

function hasAtMostOneExtraLetter(answer: string, expected: string): boolean {
  if (expected.length === 0) return false;
  if (answer === expected) return true;
  if (answer.length !== expected.length + 1) return false;

  let answerIndex = 0;
  let expectedIndex = 0;
  let skipped = false;

  while (answerIndex < answer.length && expectedIndex < expected.length) {
    if (answer[answerIndex] === expected[expectedIndex]) {
      answerIndex += 1;
      expectedIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    answerIndex += 1;
  }

  return true;
}

export function acceptsPinyin(accepted: readonly string[], raw: string): boolean {
  const answer = canonicalizePinyin(raw);
  return answer.length > 0 && accepted.some((expected) => {
    if (hasAtMostOneExtraLetter(answer, expected)) return true;
    // Many learners omit the umlaut when tone marks are unavailable. Keep `v`
    // as the canonical spelling, but also accept plain `u` for expected `ü`.
    return expected.includes("v") && hasAtMostOneExtraLetter(answer, expected.replaceAll("v", "u"));
  });
}
