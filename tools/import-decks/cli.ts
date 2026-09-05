import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Data, Effect, Layer } from "effect";
import { DECK_IDS, type DeckId } from "../../src/shared/constants";
import { compileFromCardsEffect, type CardCompileFailure } from "./compile/from-cards";
import { Fs } from "../shared/fs";

/** Typed failure for invalid command-line usage. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const USAGE =
  "Usage: npm run import:decks -- [--deck hsk-1 ...] [--output PATH] [--check]\n" +
  "  Compiles cards/ into public/game-data/. The .apkg packages are not read;\n" +
  "  run `npm run import:acards` to regenerate cards/ from them.";

const usage = Effect.fail(new UsageError({ detail: USAGE }));

type Options = { deckIds?: DeckId[]; outputDirectory?: string; check: boolean };

const parseArguments = (args: string[]): Effect.Effect<Options, UsageError, never> =>
  Effect.gen(function* () {
    const deckIds: DeckId[] = [];
    let outputDirectory: string | undefined;
    let check = false;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--check") check = true;
      else if (argument === "--deck" || argument.startsWith("--deck=")) {
        const id = argument.startsWith("--deck=") ? argument.slice("--deck=".length) : args[++index];
        if (!id || !(DECK_IDS as readonly string[]).includes(id)) return yield* usage;
        deckIds.push(id as DeckId);
      } else if (argument === "--output" || argument.startsWith("--output=")) {
        const path = argument.startsWith("--output=") ? argument.slice("--output=".length) : args[++index];
        if (!path) return yield* usage;
        outputDirectory = resolve(path);
      } else return yield* usage;
    }
    return { deckIds: deckIds.length ? [...new Set(deckIds)] : undefined, outputDirectory, check };
  });

const repositoryRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** Staleness check: recompiles into a scratch tree and compares the JSON
 * bytes. Because the compile is deterministic, any difference means the
 * generated data no longer matches `cards/`. */
const checkGenerated = (options: Options): Effect.Effect<void, UsageError | CardCompileFailure, Fs> =>
  Effect.gen(function* () {
    const generated = join(repositoryRoot, "public", "game-data");
    const scratch = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "hsk-check-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const output = join(scratch, "game-data");
    yield* compileFromCardsEffect({ repositoryRoot, outputDirectory: output, deckIds: options.deckIds });
    const stale: string[] = [];
    const names = yield* Effect.promise(() => readdir(output));
    for (const name of names) {
      const relatives = name.endsWith(".json") ? [name] : [`${name}/deck.json`];
      for (const relative of relatives) {
        const [expected, actual] = yield* Effect.promise(async () => [
          await readFile(join(output, relative), "utf8"),
          await readFile(join(generated, relative), "utf8").catch(() => ""),
        ]);
        if (expected !== actual) stale.push(relative);
      }
    }
    if (stale.length) {
      return yield* Effect.fail(new UsageError({
        detail: `Generated deck data is stale or missing:\n  ${stale.join("\n  ")}\nRun: npm run import:decks`,
      }));
    }
    console.log("Generated deck data is present and current.");
  }).pipe(Effect.scoped);

const program: Effect.Effect<void, UsageError | CardCompileFailure, Fs> = Effect.gen(function* () {
  const options = yield* parseArguments(process.argv.slice(2));
  if (options.check) {
    if (options.outputDirectory) {
      return yield* Effect.fail(new UsageError({ detail: "--output cannot be used with --check" }));
    }
    return yield* checkGenerated(options);
  }
  const result = yield* compileFromCardsEffect({
    repositoryRoot,
    outputDirectory: options.outputDirectory,
    deckIds: options.deckIds,
  });
  for (const report of result.reports) {
    console.log(
      `${report.id}: ${report.logicalWordCount} words, ${report.output.audioAssetCount} audio assets, ` +
        `fingerprint ${report.fingerprint.slice(0, 12)}`,
    );
  }
});

void Effect.runPromise(
  Effect.provide(program, Layer.mergeAll(Fs.layer)).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
