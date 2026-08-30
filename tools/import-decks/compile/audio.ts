import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { visitZip } from "../archive/zip";

export type AudioExtraction = {
  urlByFilename: Map<string, string>;
  assetCount: number;
  totalBytes: number;
};

function isMp3(prefix: Buffer): boolean {
  return prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "ID3" ||
    prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0;
}

export async function extractSelectedAudio(
  apkgPath: string,
  memberByFilename: Map<string, string>,
  outputDirectory: string,
): Promise<AudioExtraction> {
  await mkdir(outputDirectory, { recursive: true });
  const filenameByMember = new Map<string, string>();
  for (const [filename, member] of memberByFilename) {
    if (filenameByMember.has(member)) throw new Error(`Two selected audio filenames resolve to media member ${member}`);
    filenameByMember.set(member, filename);
  }
  const found = new Set<string>();
  const urlByFilename = new Map<string, string>();
  const contentPaths = new Set<string>();

  await visitZip(apkgPath, async (entry, open) => {
    const filename = filenameByMember.get(entry.fileName);
    if (!filename) return;
    if (found.has(entry.fileName)) throw new Error(`Duplicate selected media ZIP member: ${entry.fileName}`);
    found.add(entry.fileName);
    const partPath = join(outputDirectory, `.audio-${entry.fileName}.part`);
    const hash = createHash("sha256");
    let prefix = Buffer.alloc(0);
    const stream = await open();
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(bytes);
      if (prefix.length < 3) prefix = Buffer.concat([prefix, bytes.subarray(0, 3 - prefix.length)]);
    });
    try {
      await pipeline(stream, createWriteStream(partPath, { flags: "wx" }));
      if (!isMp3(prefix)) throw new Error(`Selected word audio ${filename} does not have MP3 magic bytes`);
      const digest = hash.digest("hex");
      const outputPath = join(outputDirectory, `${digest}.mp3`);
      try {
        await rename(partPath, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await rm(partPath, { force: true });
      }
      contentPaths.add(outputPath);
      urlByFilename.set(filename, `audio/${digest}.mp3`);
    } catch (error) {
      await rm(partPath, { force: true });
      throw error;
    }
  });

  const missing = [...filenameByMember.keys()].filter((member) => !found.has(member));
  if (missing.length) throw new Error(`Selected media members absent from ZIP: ${missing.sort().join(", ")}`);
  let totalBytes = 0;
  for (const path of contentPaths) totalBytes += (await stat(path)).size;
  return { urlByFilename, assetCount: contentPaths.size, totalBytes };
}
