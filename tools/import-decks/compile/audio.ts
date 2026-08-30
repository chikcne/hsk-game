import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { visitZip } from "../archive/zip";

const execFileAsync = promisify(execFile);

export type AudioExtraction = {
  urlByFilename: Map<string, string>;
  assetCount: number;
  totalBytes: number;
};

function isMp3(prefix: Buffer): boolean {
  return prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "ID3" ||
    prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Returns the silence separating the Chinese pronunciation from a spoken
 * source qualifier. A terminal silence is deliberately rejected: numbered
 * source suffixes are not spoken and therefore need no edit. */
export function pronunciationEndFromSilenceLog(log: string): number | null {
  const events = [...log.matchAll(/silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/gu)]
    .map((match) => ({ kind: match[1]!, time: Number(match[2]) }));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind !== "start" || event.time <= 0.05) continue;
    const resumed = events.slice(index + 1).find((later) => later.kind === "end");
    if (resumed && resumed.time > event.time) return event.time;
  }
  return null;
}

async function removeSpokenQualifier(inputPath: string, outputPath: string, filename: string): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static does not provide a binary for this platform");
  const detected = await execFileAsync(ffmpegPath, [
    "-hide_banner", "-nostdin", "-i", inputPath,
    "-af", "silencedetect=noise=-35dB:d=0.08", "-f", "null", "-",
  ]);
  const pronunciationEnd = pronunciationEndFromSilenceLog(detected.stderr);
  if (pronunciationEnd === null) {
    throw new Error(`Could not separate pronunciation from the spoken qualifier in ${filename}`);
  }
  // Retain a small amount of the separating silence so the syllable's decay is
  // not clipped, then add a short clean tail for comfortable replay.
  const end = (pronunciationEnd + 0.04).toFixed(3);
  await execFileAsync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath,
    "-af", `atrim=end=${end},asetpts=PTS-STARTPTS,apad=pad_dur=0.08`,
    "-map_metadata", "-1", "-codec:a", "libmp3lame", "-q:a", "4", "-f", "mp3", outputPath,
  ]);
}

export async function extractSelectedAudio(
  apkgPath: string,
  memberByFilename: Map<string, string>,
  outputDirectory: string,
  pronunciationOnlyFilenames: ReadonlySet<string> = new Set(),
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
    const cleanedPath = `${partPath}.clean.mp3`;
    let prefix = Buffer.alloc(0);
    const stream = await open();
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (prefix.length < 3) prefix = Buffer.concat([prefix, bytes.subarray(0, 3 - prefix.length)]);
    });
    try {
      await pipeline(stream, createWriteStream(partPath, { flags: "wx" }));
      if (!isMp3(prefix)) throw new Error(`Selected word audio ${filename} does not have MP3 magic bytes`);
      let sourcePath = partPath;
      if (pronunciationOnlyFilenames.has(filename)) {
        await removeSpokenQualifier(partPath, cleanedPath, filename);
        sourcePath = cleanedPath;
      }
      const digest = await sha256(sourcePath);
      const outputPath = join(outputDirectory, `${digest}.mp3`);
      try {
        await rename(sourcePath, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await rm(sourcePath, { force: true });
      }
      await rm(partPath, { force: true });
      contentPaths.add(outputPath);
      urlByFilename.set(filename, `audio/${digest}.mp3`);
    } catch (error) {
      await Promise.all([rm(partPath, { force: true }), rm(cleanedPath, { force: true })]);
      throw error;
    }
  });

  const missing = [...filenameByMember.keys()].filter((member) => !found.has(member));
  if (missing.length) throw new Error(`Selected media members absent from ZIP: ${missing.sort().join(", ")}`);
  let totalBytes = 0;
  for (const path of contentPaths) totalBytes += (await stat(path)).size;
  return { urlByFilename, assetCount: contentPaths.size, totalBytes };
}
