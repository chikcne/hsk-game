import { readFile } from "node:fs/promises";
import type { MediaIndex } from "../raw-types";

const SAFE_MEMBER = /^(?:0|[1-9][0-9]*)$/u;

export function assertSafeMediaFilename(filename: string): void {
  if (
    !filename ||
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    throw new Error(`Unsafe media filename: ${JSON.stringify(filename)}`);
  }
}

export function parseMediaMap(value: unknown): MediaIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("APKG media must be a JSON object");
  }
  const memberByFilename = new Map<string, string>();
  const filenameByMember = new Map<string, string>();
  for (const [member, filename] of Object.entries(value)) {
    if (!SAFE_MEMBER.test(member)) throw new Error(`Unsafe media member name: ${JSON.stringify(member)}`);
    if (typeof filename !== "string") throw new Error(`Media member ${member} has a non-string filename`);
    assertSafeMediaFilename(filename);
    const previous = memberByFilename.get(filename);
    if (previous !== undefined && previous !== member) {
      throw new Error(`Duplicate media filename ${JSON.stringify(filename)} maps to ${previous} and ${member}`);
    }
    memberByFilename.set(filename, member);
    filenameByMember.set(member, filename);
  }
  return { memberByFilename, filenameByMember };
}

export async function readMediaMap(path: string): Promise<MediaIndex> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse APKG media JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseMediaMap(parsed);
}

export function parseSoundReference(value: string): string {
  const match = /^\[sound:([^\[\]\r\n]+)\]$/u.exec(value.trim());
  if (!match) throw new Error(`Expected exactly one [sound:filename] token, got ${JSON.stringify(value)}`);
  const filename = match[1]!;
  assertSafeMediaFilename(filename);
  if (!/\.mp3$/iu.test(filename)) throw new Error(`Unsupported word audio format: ${filename}`);
  return filename;
}
