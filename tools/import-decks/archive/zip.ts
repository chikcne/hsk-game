import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error(`Could not open ZIP: ${path}`));
      else resolve(zip);
    });
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`Could not read ZIP member ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

/** Visits ZIP entries serially without buffering their contents. */
export async function visitZip(
  path: string,
  visitor: (entry: Entry, open: () => Promise<NodeJS.ReadableStream>) => Promise<void>,
): Promise<void> {
  const zip = await openZip(path);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on("entry", (entry: Entry) => {
      void visitor(entry, () => entryStream(zip, entry)).then(
        () => zip.readEntry(),
        fail,
      );
    });
    zip.readEntry();
  });
}

export type ArchiveEssentials = {
  collectionPath: string;
  mediaPath: string;
  archiveEntryCount: number;
};

export async function extractArchiveEssentials(apkgPath: string, tempDir: string): Promise<ArchiveEssentials> {
  const collectionPath = `${tempDir}/collection.anki21`;
  const mediaPath = `${tempDir}/media`;
  let archiveEntryCount = 0;
  const seen = new Set<string>();
  await visitZip(apkgPath, async (entry, open) => {
    archiveEntryCount += 1;
    if (entry.fileName !== "collection.anki21" && entry.fileName !== "media") return;
    if (seen.has(entry.fileName)) throw new Error(`Duplicate required ZIP member: ${entry.fileName}`);
    seen.add(entry.fileName);
    const destination = entry.fileName === "media" ? mediaPath : collectionPath;
    await mkdir(dirname(destination), { recursive: true });
    await pipeline(await open(), createWriteStream(destination, { flags: "wx" }));
  });
  for (const required of ["collection.anki21", "media"]) {
    if (!seen.has(required)) throw new Error(`APKG is missing required member: ${required}`);
  }
  return { collectionPath, mediaPath, archiveEntryCount };
}

export async function readChecksumFile(path: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?([^/\\]+)$/u.exec(line.trim());
    if (!match) throw new Error(`Malformed checksum line: ${line}`);
    result.set(match[2]!, match[1]!);
  }
  return result;
}
