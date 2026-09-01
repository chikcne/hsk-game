import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractStrokeBundles, loadGeneratedDecks, STROKE_SOURCE } from "./extract";
import type { StrokeOverrides } from "./types";

function sourceArgument(args: string[]): string {
  const flag = args.indexOf("--source");
  const value = flag >= 0 ? args[flag + 1] : args[0];
  if (!value) {
    throw new Error("Usage: npm run import:strokes -- --source /path/to/makemeahanzi/graphics.txt");
  }
  return path.resolve(value);
}

async function main() {
  const rootDir = process.cwd();
  const graphicsPath = sourceArgument(process.argv.slice(2));
  const outputDir = path.join(rootDir, "public", "stroke-data");
  const overrides = JSON.parse(await readFile(path.join(rootDir, "tools", "import-strokes", "overrides.json"), "utf8")) as StrokeOverrides;
  const decks = await loadGeneratedDecks(rootDir);
  const manifest = await extractStrokeBundles({ graphicsPath, outputDir, decks, overrides });
  const noticesDir = path.join(rootDir, "tools", "import-strokes", "notices");
  await Promise.all([
    cp(path.join(noticesDir, "COPYING"), path.join(outputDir, "COPYING")),
    cp(path.join(noticesDir, "ARPHICPL.txt"), path.join(outputDir, "ARPHICPL.txt")),
    cp(path.join(noticesDir, "HANZI_WRITER_LICENSE.txt"), path.join(outputDir, "HANZI_WRITER_LICENSE.txt")),
  ]);
  await writeFile(path.join(outputDir, "SOURCE.md"), `# Stroke data provenance\n\nThe JSON bundles in this directory are trimmed and reformatted derivatives of\n[Make Me a Hanzi](${STROKE_SOURCE.repository}) \`graphics.txt\`. Only characters\nused by the six generated HSK decks, the bundled demo deck, and the fixed UI\nlabels are retained.\n\n- Source commit: \`${STROKE_SOURCE.commit}\`\n- Source \`graphics.txt\` SHA-256: \`${STROKE_SOURCE.graphicsSha256}\`\n- Extraction date: ${manifest.extractionDate}\n- Extractor: \`tools/import-strokes/\`\n- Applied corrections: ${manifest.appliedOverrides.map((item) => `${item.character} (${item.issue})`).join(", ") || "none"}\n\nThe source graphics are derived from Arphic PL KaitiM GB and Arphic PL UKai.\nThey are redistributed under the Arphic Public License in \`ARPHICPL.txt\`. See\n\`COPYING\` for the upstream notice. The runtime renderer is Hanzi Writer,\nlicensed under the MIT license in \`HANZI_WRITER_LICENSE.txt\`.\n\nCitation: Kishore, Shaunak (2018), Make Me a Hanzi (commit 618dbab).\n`);
  console.log(`Wrote ${manifest.uniqueCharacterCount} characters to ${outputDir}`);
  for (const [id, bundle] of Object.entries(manifest.bundles)) console.log(`  ${id}: ${bundle.characterCount} characters, ${bundle.bytes} bytes`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
