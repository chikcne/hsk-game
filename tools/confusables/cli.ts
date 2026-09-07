import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECK_IDS } from "../../src/shared/constants";
import { artifactJson, buildConfusableGroups, type ConfusableOverrides } from "./generate";

const USAGE =
  "Usage: npm run generate:confusables -- [--check] [--debug]\n" +
  "  Regenerates src/shared/data/confusable-meanings.json from cards/ and\n" +
  "  tools/confusables/overrides.json. --check compares bytes instead of writing.";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const outputPath = join(repositoryRoot, "src", "shared", "data", "confusable-meanings.json");

type Card = { hanzi: string; meaning: string; level: number };

function loadCorpus(): Card[] {
  const cards: Card[] = [];
  for (const deckId of DECK_IDS) {
    const directory = join(repositoryRoot, "cards", deckId);
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith(".acard")) continue;
      const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Card;
      cards.push({ hanzi: parsed.hanzi, meaning: parsed.meaning, level: parsed.level });
    }
  }
  return cards;
}

function loadOverrides(): ConfusableOverrides {
  const path = join(repositoryRoot, "tools", "confusables", "overrides.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ConfusableOverrides;
  for (const key of ["forceLink", "forceUnlink", "forceUnlinkTags"] as const) {
    if (!Array.isArray(parsed[key])) throw new Error(`${path}: missing "${key}" array`);
  }
  return parsed;
}

const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");
const debug = arguments_.includes("--debug");
if (arguments_.some((argument) => !argument.startsWith("--")) || arguments_.length > 2) {
  console.error(USAGE);
  process.exit(1);
}

const result = buildConfusableGroups(loadCorpus(), loadOverrides());
const generated = artifactJson(result);

if (check) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== generated) {
    console.error(`Generated confusable-meanings data is stale or missing:\n  ${outputPath}\nRun: npm run generate:confusables`);
    process.exit(1);
  }
  console.log("Generated confusable-meanings data is present and current.");
  process.exit(0);
}

if (debug) {
  const bySharedWord = new Map<string, number>();
  for (const pair of result.pairs) {
    for (const word of pair.sharedWords) bySharedWord.set(word, (bySharedWord.get(word) ?? 0) + 1);
  }
  console.log("== candidate pairs (before force-unlink), with firing signals ==");
  for (const { keys, signals, sharedWords, sharedClasses } of [...result.pairs].sort((left, right) =>
    left.keys[0] < right.keys[0] ? -1 : 1,
  )) {
    const fired = [
      signals.class ? `class:${sharedClasses.join("/")}` : null,
      signals.word ? `word:${sharedWords.join("/")}` : null,
      signals.charWithCloseness ? "char" : null,
      signals.forcedLink ? "forced" : null,
    ].filter(Boolean).join(" ");
    console.log(`  ${keys[0]}  ||  ${keys[1]}   [${fired}]`);
  }
  console.log("\n== shared words by pair count (FP hotspots) ==");
  for (const [word, count] of [...bySharedWord.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)) {
    console.log(`  ${word}: ${count}`);
  }
}

writeFileSync(outputPath, generated);
console.log(`Wrote ${outputPath}`);
console.log(`  meaning keys in corpus: ${result.report.meaningKeys}`);
console.log(`  candidate pairs: ${result.report.candidatePairs}`);
console.log(`    by class signal: ${result.report.pairsBySignal.class}`);
console.log(`    by shared-word signal: ${result.report.pairsBySignal.word}`);
console.log(`    by shared-char corroboration: ${result.report.pairsBySignal.charWithCloseness}`);
console.log(`  force-linked pairs applied: ${result.report.forceLinkedPairs}`);
console.log(`  force-unlinked pairs applied: ${result.report.forceUnlinkedPairs}`);
console.log(`  groups: ${result.report.groups} covering ${result.report.groupedKeys} keys`);
for (const coverage of result.report.coverageByLevel) {
  console.log(
    `    HSK ${coverage.level}: ${coverage.keysInGroups}/${coverage.keys} keys grouped across ${coverage.groupsTouched} groups`,
  );
}
