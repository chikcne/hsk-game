import { open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SaveFile } from "../../shared/schemas";

export type AtomicWriteStage =
  | "afterTempOpen"
  | "afterPartialWrite"
  | "afterFlush"
  | "beforeRename";

export type FaultInjector = (stage: AtomicWriteStage) => void | Promise<void>;

export type AtomicWriterOptions = {
  faultInjector?: FaultInjector;
  nonce?: () => string;
};

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function serializeSave(save: SaveFile): string {
  return `${JSON.stringify(sortJson(save), null, 2)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

export class AtomicSaveWriter {
  private readonly faultInjector?: FaultInjector;
  private readonly nonce: () => string;

  constructor(
    readonly savePath: string,
    options: AtomicWriterOptions = {},
  ) {
    this.faultInjector = options.faultInjector;
    this.nonce = options.nonce ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  }

  async cleanupStaleTemps(): Promise<void> {
    const directory = dirname(this.savePath);
    const prefixes = [`${basename(this.savePath)}.tmp-`];
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries
      .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
      .map(async (entry) => {
        try {
          await unlink(join(directory, entry));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }));
  }

  async write(save: SaveFile): Promise<void> {
    const serialized = serializeSave(save);
    const directory = dirname(this.savePath);
    const tempPath = `${this.savePath}.tmp-${process.pid}-${this.nonce()}`;
    let handle;
    let renamed = false;

    try {
      handle = await open(tempPath, "wx", 0o600);
      await this.faultInjector?.("afterTempOpen");

      const midpoint = Math.max(1, Math.floor(serialized.length / 2));
      await handle.writeFile(serialized.slice(0, midpoint), "utf8");
      await this.faultInjector?.("afterPartialWrite");
      await handle.writeFile(serialized.slice(midpoint), "utf8");
      await handle.sync();
      await this.faultInjector?.("afterFlush");
      await handle.close();
      handle = undefined;

      await this.faultInjector?.("beforeRename");
      await rename(tempPath, this.savePath);
      renamed = true;
      await syncDirectory(directory);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(tempPath).catch(() => undefined);
    }
  }
}
