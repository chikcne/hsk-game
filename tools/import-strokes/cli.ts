import path from "node:path";
import { Data, Effect, Layer } from "effect";
import { extractStrokeBundles, loadGeneratedDecks, STROKE_SOURCE, StrokeDataError, type StrokeExtractError } from "./extract";
import type { StrokeOverrides } from "./types";
import { Fs, type FsError } from "../shared/fs";

/** Typed failure for invalid command-line usage. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly detail: string;
}> {
  get message(): string {
    return this.detail;
  }
}

const decodeOverridesError = (error: unknown): StrokeDataError =>
  new StrokeDataError({ detail: error instanceof Error ? error.message : String(error) });

const sourceArgumentEffect = (args: string[]): Effect.Effect<string, UsageError, never> =>
  Effect.gen(function* () {
    const flag = args.indexOf("--source");
    const value = flag >= 0 ? args[flag + 1] : args[0];
    if (!value) {
      return yield* Effect.fail(new UsageError({
        detail: "Usage: npm run import:strokes -- --source /path/to/makemeahanzi/graphics.txt",
      }));
    }
    return path.resolve(value);
  });

const readOverridesEffect = (path: string): Effect.Effect<StrokeOverrides, FsError | StrokeDataError, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const text = yield* fs.readTextFile(path);
    return yield* Effect.try({
      try: () => JSON.parse(text) as StrokeOverrides,
      catch: decodeOverridesError,
    });
  });

const program: Effect.Effect<void, UsageError | StrokeExtractError, Fs> = Effect.gen(function* () {
  const fs = yield* Fs;
  const rootDir = process.cwd();
  const graphicsPath = yield* sourceArgumentEffect(process.argv.slice(2));
  const outputDir = path.join(rootDir, "public", "stroke-data");
  const overrides = yield* readOverridesEffect(path.join(rootDir, "tools", "import-strokes", "overrides.json"));
  const decks = yield* loadGeneratedDecks(rootDir);
  const manifest = yield* extractStrokeBundles({ graphicsPath, outputDir, decks, overrides });
  const noticesDir = path.join(rootDir, "tools", "import-strokes", "notices");
  yield* Effect.all(
    [
      fs.copyFile(path.join(noticesDir, "COPYING"), path.join(outputDir, "COPYING")),
      fs.copyFile(path.join(noticesDir, "ARPHICPL.txt"), path.join(outputDir, "ARPHICPL.txt")),
      fs.copyFile(path.join(noticesDir, "HANZI_WRITER_LICENSE.txt"), path.join(outputDir, "HANZI_WRITER_LICENSE.txt")),
    ],
    { concurrency: "unbounded" },
  );
  yield* fs.writeFile(
    path.join(outputDir, "SOURCE.md"),
    `# Stroke data provenance\n\nThe JSON bundles in this directory are trimmed and reformatted derivatives of\n[Make Me a Hanzi](${STROKE_SOURCE.repository}) \`graphics.txt\`. Only characters\nused by the six generated HSK decks, the bundled demo deck, and the fixed UI\nlabels are retained.\n\n- Source commit: \`${STROKE_SOURCE.commit}\`\n- Source \`graphics.txt\` SHA-256: \`${STROKE_SOURCE.graphicsSha256}\`\n- Extraction date: ${manifest.extractionDate}\n- Extractor: \`tools/import-strokes/\`\n- Applied corrections: ${manifest.appliedOverrides.map((item) => `${item.character} (${item.issue})`).join(", ") || "none"}\n\nThe source graphics are derived from Arphic PL KaitiM GB and Arphic PL UKai.\nThey are redistributed under the Arphic Public License in \`ARPHICPL.txt\`. See\n\`COPYING\` for the upstream notice. The runtime renderer is Hanzi Writer,\nlicensed under the MIT license in \`HANZI_WRITER_LICENSE.txt\`.\n\nCitation: Kishore, Shaunak (2018), Make Me a Hanzi (commit 618dbab).\n`,
  );
  console.log(`Wrote ${manifest.uniqueCharacterCount} characters to ${outputDir}`);
  for (const [id, bundle] of Object.entries(manifest.bundles)) console.log(`  ${id}: ${bundle.characterCount} characters, ${bundle.bytes} bytes`);
});

const liveDependencies: Layer.Layer<Fs> = Fs.layer;

void Effect.runPromise(Effect.provide(program, liveDependencies).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.error(error.message);
    process.exitCode = 1;
  })),
));
