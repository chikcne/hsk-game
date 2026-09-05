import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { validateCards } from "./validate";
import { Fs } from "../shared/fs";

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const args = process.argv.slice(2);
const deep = args.includes("--deep");
const positional = args.find((argument) => !argument.startsWith("--"));
const cardsRoot = positional ? resolve(positional) : join(repositoryRoot, "cards");

void Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const report = yield* validateCards(cardsRoot, { deep });
      for (const [grade, count] of Object.entries(report.byGrade)) console.log(`${grade}: ${count} cards`);
      console.log(`\n${report.cards} cards valid.`);
      console.log(`audio: ${report.audioAssets} assets, ${report.orphanAudio} unreferenced`);
      if (report.deep) {
        console.log(`minimum safe distractors across all grades: ${report.minimumSafeDistractors}`);
      } else {
        console.log("(fast path: audio content hashes and distractor pools not checked — pass --deep)");
      }
    }),
    Layer.mergeAll(Fs.layer),
  ).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
