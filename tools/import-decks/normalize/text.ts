const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  ensp: " ", emsp: " ", ndash: "–", mdash: "—", hellip: "…", middot: "·",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/giu, (token, body: string) => {
    if (body[0] === "#") {
      const hex = body[1]?.toLowerCase() === "x";
      const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)) {
        return String.fromCodePoint(value);
      }
      return token;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? token;
  });
}

/** Small non-DOM HTML tokenizer: source tags are discarded, br/block boundaries become spaces. */
function stripTags(input: string): string {
  let output = "";
  let index = 0;
  while (index < input.length) {
    if (input[index] !== "<") {
      output += input[index++];
      continue;
    }
    const start = index;
    index += 1;
    let quote: string | null = null;
    while (index < input.length) {
      const character = input[index]!;
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      index += 1;
    }
    if (index >= input.length) {
      output += input.slice(start);
      break;
    }
    const tag = input.slice(start + 1, index).trim().toLowerCase();
    if (/^\/?(?:br|div|p|li|tr|table|ul|ol)(?:\s|\/|$)/u.test(tag)) output += " ";
    index += 1;
  }
  return output;
}

export function sanitizeText(input: string): string {
  return decodeEntities(stripTags(input)).normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizedKey(input: string): string {
  return sanitizeText(input).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

export function nullableText(input: string): string | null {
  const result = sanitizeText(input);
  return result || null;
}
