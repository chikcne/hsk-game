import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "../import-decks/compile/stable-json";
import { generateCurriculum } from "./generator";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const generated = await generateCurriculum(repositoryRoot);
const [manifest, lock] = await Promise.all([readFile(join(repositoryRoot, "cards/curriculum.json"), "utf8"), readFile(join(repositoryRoot, "cards/curriculum.lock.json"), "utf8")]);
if (manifest !== stableJson(generated.manifest)) throw new Error("cards/curriculum.json is stale; run npm run sort:curriculum");
if (lock !== stableJson(generated.lock)) throw new Error("cards/curriculum.lock.json is stale; run npm run sort:curriculum");
console.log(`curriculum valid: ${generated.cards.length} cards, ${generated.manifest.levels.reduce((sum, level) => sum + level.lessons.length, 0)} lessons`);
