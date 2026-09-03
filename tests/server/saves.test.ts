import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeckCatalog } from "../../src/server/saves/manifests";
import {
  CorruptSaveError,
  RevisionConflictError,
  SaveRepository,
} from "../../src/server/saves/repository";
import { parseSaveSnapshot } from "../../src/server/saves/validation";
import type { AtomicWriteStage } from "../../src/server/saves/atomic-writer";
import { makeSnapshot, makeSnapshotWithWord } from "./helpers";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hanzi-saves-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}

describe("SaveRepository", () => {
  it("returns a valid first-run default and assigns server revisions", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({
      directory,
      now: clock("2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z"),
    });
    await repository.initialize();

    const initial = await repository.load();
    expect(initial.firstRun).toBe(true);
    expect(initial.save.revision).toBe(0);

    const written = await repository.save(0, makeSnapshot());
    expect(written).toMatchObject({ revision: 1, savedAt: "2025-01-02T00:00:00.000Z" });
    const source = await readFile(join(directory, "default.json"), "utf8");
    expect(source.endsWith("\n")).toBe(true);
    expect(JSON.parse(source)).toEqual(written);
  });

  it("rejects a stale revision without changing disk", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory });
    await repository.initialize();
    await repository.save(0, makeSnapshot());

    await expect(repository.save(0, makeSnapshot())).rejects.toBeInstanceOf(RevisionConflictError);
    expect((await repository.load()).save.revision).toBe(1);
  });

  it("serializes concurrent writes so only one expected revision wins", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory });
    await repository.initialize();

    const results = await Promise.allSettled([
      repository.save(0, makeSnapshot()),
      repository.save(0, { ...makeSnapshot(), settings: { ...makeSnapshot().settings, masterVolume: 0.2 } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await repository.load()).save.revision).toBe(1);
  });

  for (const stage of ["afterTempOpen", "afterPartialWrite", "afterFlush", "beforeRename"] as const) {
    it(`keeps the original readable after a ${stage} failure`, async () => {
      const directory = await temporaryDirectory();
      const initial = new SaveRepository({ directory });
      await initial.initialize();
      await initial.save(0, makeSnapshot());

      const failing = new SaveRepository({
        directory,
        writer: { faultInjector: (current: AtomicWriteStage) => {
          if (current === stage) throw new Error(`injected ${stage}`);
        } },
      });
      await failing.initialize();
      const changed = makeSnapshot();
      changed.settings.masterVolume = 0.1;
      await expect(failing.save(1, changed)).rejects.toThrow(`injected ${stage}`);

      const verifier = new SaveRepository({ directory });
      await verifier.initialize();
      expect((await verifier.load()).save).toMatchObject({ revision: 1, settings: { masterVolume: 0.8 } });
      expect((await readdir(directory)).some((name) => name.startsWith("default.json.tmp-"))).toBe(false);
    });
  }

  it("cleans stale temporary files on startup", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "default.json.tmp-99-stale"), "partial");
    await writeFile(join(directory, "unrelated.tmp"), "keep");
    const repository = new SaveRepository({ directory });
    await repository.initialize();
    expect(await readdir(directory)).toEqual(["unrelated.tmp"]);
  });

  it("quarantines malformed main and atomically recovers a valid backup", async () => {
    const directory = await temporaryDirectory();
    const repository = new SaveRepository({ directory });
    await repository.initialize();
    await repository.save(0, makeSnapshot());
    const changed = makeSnapshot();
    changed.settings.masterVolume = 0.3;
    await repository.save(1, changed); // backup is revision 1
    await writeFile(join(directory, "default.json"), "{broken");

    const recovered = await repository.load();
    expect(recovered.save.revision).toBe(1);
    expect(recovered.recovery?.source).toBe("backup");
    expect(recovered.recovery?.quarantinedFile).toMatch(/^default\.corrupt-/);
    expect(JSON.parse(await readFile(join(directory, "default.json"), "utf8"))).toMatchObject({ revision: 1 });
  });

  it("quarantines malformed main and reports explicit recovery when no backup exists", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "default.json"), "not json");
    const repository = new SaveRepository({ directory });
    await repository.initialize();

    await expect(repository.load()).rejects.toBeInstanceOf(CorruptSaveError);
    const entries = await readdir(directory);
    expect(entries).not.toContain("default.json");
    expect(entries.some((name) => /^default\.corrupt-/.test(name))).toBe(true);
    // Refreshing must keep reporting unresolved corruption, not silently return
    // a blank first-run profile. A revision-zero PUT is the explicit reset.
    await expect(repository.load()).rejects.toBeInstanceOf(CorruptSaveError);
    expect((await repository.save(0, makeSnapshot())).revision).toBe(1);
  });

  it("does not let an ordinary PUT silently replace newly discovered corruption", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "default.json"), "not json");
    const repository = new SaveRepository({ directory });
    await repository.initialize();

    await expect(repository.save(0, makeSnapshot())).rejects.toMatchObject({
      name: "CorruptSaveError",
      newlyQuarantined: true,
    });
    expect((await readdir(directory)).some((name) => /^default\.corrupt-/.test(name))).toBe(true);
  });
});

describe("save validation", () => {
  it("rejects unsupported save schema versions", () => {
    const raw = { ...makeSnapshot(), schemaVersion: 1 };
    expect(() => parseSaveSnapshot(raw)).toThrow();
  });

  it("enforces scheduler and counter invariants", () => {
    const snapshot = makeSnapshotWithWord();
    snapshot.levels["hsk-1"]!.words["word-1"]!.attempts = 1;
    snapshot.levels["hsk-1"]!.words["word-1"]!.nextEligibleSpawn = 10;
    expect(() => parseSaveSnapshot(snapshot)).toThrow(/sum of outcome counters|intervening spawns/);
  });

  it("rejects scheduler states that domain constructors cannot use", () => {
    const zeroRng = makeSnapshot();
    zeroRng.schedulerRng = [0, 0, 0, 0];
    expect(() => parseSaveSnapshot(zeroRng)).toThrow(/must not be all zero/);

    const invalidCard = makeSnapshotWithWord();
    invalidCard.levels["hsk-1"]!.words["word-1"]!.pinyin = {
      ...invalidCard.levels["hsk-1"]!.words["word-1"]!.pinyin,
      state: "review",
      reps: 3,
      stability: 3,
      difficulty: 0,
      lastReview: "2024-12-29T00:00:00.000Z",
    };
    expect(() => parseSaveSnapshot(invalidCard)).toThrow(/difficulty of at least 1/);

    const reversedDates = makeSnapshotWithWord();
    reversedDates.levels["hsk-1"]!.words["word-1"]!.pinyin = {
      ...reversedDates.levels["hsk-1"]!.words["word-1"]!.pinyin,
      state: "review",
      reps: 3,
      stability: 3,
      difficulty: 5,
      due: "2025-01-01T00:00:00.000Z",
      lastReview: "2099-01-01T00:00:00.000Z",
    };
    expect(() => parseSaveSnapshot(reversedDates)).toThrow(/must not precede/);
  });

  it("rejects unknown current word IDs when a generated manifest is available", () => {
    const catalog: DeckCatalog = new Map([
      ["hsk-1", { fingerprint: "fixture-fingerprint", wordIds: new Set(["known"]) }],
    ]);
    expect(() => parseSaveSnapshot(makeSnapshotWithWord("unknown"), catalog)).toThrow(/not present/);
    expect(() => parseSaveSnapshot(makeSnapshotWithWord("known"), catalog)).not.toThrow();
  });

  it("loads an old deck fingerprint for reconciliation instead of quarantining it", async () => {
    const directory = await temporaryDirectory();
    const oldSnapshot = makeSnapshotWithWord("removed-word");
    const persisted = {
      ...oldSnapshot,
      revision: 3,
      savedAt: "2025-01-01T00:00:00.000Z",
    };
    await writeFile(join(directory, "default.json"), JSON.stringify(persisted));
    const catalog: DeckCatalog = new Map([
      ["hsk-1", { fingerprint: "new-fingerprint", wordIds: new Set(["new-word"]) }],
    ]);
    const repository = new SaveRepository({ directory, catalog });
    await repository.initialize();

    expect((await repository.load()).save.levels["hsk-1"]?.words).toHaveProperty("removed-word");
    await expect(repository.save(3, oldSnapshot)).rejects.toThrow(/not present/);
  });

  it("rejects unknown keys instead of silently stripping them", () => {
    expect(() => parseSaveSnapshot({ ...makeSnapshot(), surprise: true })).toThrow();
  });
});
