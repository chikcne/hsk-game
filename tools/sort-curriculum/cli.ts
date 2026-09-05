import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "../import-decks/compile/stable-json";
import { generateCurriculum } from "./generator";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const generated = await generateCurriculum(repositoryRoot);
for (const item of generated.cards) await writeFile(join(repositoryRoot, "cards", item.relative), stableJson(item.card));
await writeFile(join(repositoryRoot, "cards/curriculum.json"), stableJson(generated.manifest));
await writeFile(join(repositoryRoot, "cards/curriculum.lock.json"), stableJson(generated.lock));
const ledgerPath = join(repositoryRoot, "cards/.extraction.json");
try {
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { extractorVersion: string; files: Record<string, string> };
  for (const item of generated.cards) ledger.files[item.relative] = createHash("sha256").update(stableJson(item.card)).digest("hex");
  await writeFile(ledgerPath, stableJson(ledger));
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}
for (const level of generated.manifest.levels) console.log(`${level.deckId}: ${level.cardCount} cards in ${level.lessons.length} lessons`);
