import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentUnitsForLabel } from "./gloss";
import { classTagsForLabel } from "./lexicon";
import { normalizedKey } from "../import-decks/normalize/text";

const root = process.argv[2] ?? process.cwd();
const cards: Array<{ hanzi: string; meaning: string }> = [];
for (const deckId of readdirSync(join(root, "cards")).sort()) {
  if (!deckId.startsWith("hsk-")) continue;
  for (const name of readdirSync(join(root, "cards", deckId)).sort()) {
    if (!name.endsWith(".acard")) continue;
    cards.push(JSON.parse(readFileSync(join(root, "cards", deckId, name), "utf8")));
  }
}

type Info = { labels: Set<string>; hanzi: Set<string>; units: Set<string>; tags: Set<string> };
const info = new Map<string, Info>();
for (const card of cards) {
  const key = normalizedKey(card.meaning);
  let entry = info.get(key);
  if (!entry) {
    const units = contentUnitsForLabel(card.meaning);
    entry = { labels: new Set(), hanzi: new Set(), units: new Set(units), tags: classTagsForLabel(card.meaning) };
    info.set(key, entry);
  }
  entry.labels.add(card.meaning);
  for (const character of card.hanzi) entry.hanzi.add(character);
}

const artifact = JSON.parse(readFileSync(join(root, "src/shared/data/confusable-meanings.json"), "utf8"));
const minSize = Number(process.argv[3] ?? 6);
for (const group of [...artifact.groups].sort((a, b) => b.meaningKeys.length - a.meaningKeys.length)) {
  if (group.meaningKeys.length < minSize) break;
  console.log(`\n== ${group.id} [${group.meaningKeys.length}] ==`);
  for (const key of group.meaningKeys) {
    const entry = info.get(key)!;
    const label = [...entry.labels].sort()[0];
    console.log(`  ${key}  hanzi=${[...entry.hanzi].join("")}  tags=${[...entry.tags].join(",") || "-"}  units={${[...entry.units].join(" ")||""}}  << ${label}`);
  }
  console.log("  intra-group pairs:");
  for (let i = 0; i < group.meaningKeys.length; i += 1) {
    for (let j = i + 1; j < group.meaningKeys.length; j += 1) {
      const a = info.get(group.meaningKeys[i]!)!;
      const b = info.get(group.meaningKeys[j]!)!;
      const sharedWords = [...a.units].filter((u) => b.units.has(u));
      const sharedTags = [...a.tags].filter((t) => b.tags.has(t));
      const sharedChars = [...a.hanzi].filter((c) => b.hanzi.has(c));
      const wordOk = Math.min(a.units.size, b.units.size) >= 2 && sharedWords.length * 3 >= Math.min(a.units.size, b.units.size) * 2;
      const signals = [
        sharedTags.length ? `class:${sharedTags.join("/")}` : null,
        wordOk ? `word:${sharedWords.join("/")}` : null,
        sharedChars.length && (sharedTags.length || wordOk) ? "char" : null,
      ].filter(Boolean);
      if (signals.length) console.log(`    ${group.meaningKeys[i]}  ||  ${group.meaningKeys[j]}   [${signals.join(" ")}]`);
    }
  }
}
