import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "../import-decks/compile/stable-json";
import { orderedJson } from "./ordered-json";
import { generateCurriculum } from "./generator";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const generated = await generateCurriculum(repositoryRoot);
for (const item of generated.cards) await writeFile(join(repositoryRoot, "cards", item.relative), stableJson(item.card));
// The manifest is the one artifact whose key order carries meaning, so it is
// written in insertion order rather than stableJson's sorted order.
await writeFile(join(repositoryRoot, "cards/curriculum.json"), orderedJson(generated.manifest));
await writeFile(join(repositoryRoot, "cards/curriculum.lock.json"), stableJson(generated.lock));
const ledgerPath = join(repositoryRoot, "cards/.extraction.json");
try {
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { extractorVersion: string; files: Record<string, string> };
  for (const item of generated.cards) ledger.files[item.relative] = createHash("sha256").update(stableJson(item.card)).digest("hex");
  await writeFile(ledgerPath, stableJson(ledger));
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}
for (const [grade, count] of generated.gradeCounts) console.log(`hsk-${grade}: ${count} cards`);
console.log(`total: ${Object.keys(generated.manifest).length} entries`);
