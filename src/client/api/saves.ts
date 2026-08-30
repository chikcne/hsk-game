import { DEFAULT_SETTINGS } from "../../shared/constants";
import type { SaveFile } from "../../shared/schemas";

const blankSave = (): SaveFile => ({
  schemaVersion: 1, profileId: "default", revision: 0, savedAt: new Date(0).toISOString(),
  settings: { ...DEFAULT_SETTINGS }, levels: {},
  lifetime: { score: 0, resolvedEnemies: 0, completeCorrect: 0, wrongPinyin: 0, wrongMeaning: 0, landed: 0, bestStreak: 0, totalThinkingMs: 0 },
});

export async function loadSave(): Promise<{ save: SaveFile; online: boolean }> {
  try {
    const response = await fetch("/api/saves/default");
    if (!response.ok) throw new Error(`Save service returned ${response.status}`);
    return { save: await response.json() as SaveFile, online: true };
  } catch {
    const cached = localStorage.getItem("hanzi-defender-emergency-save");
    return { save: cached ? JSON.parse(cached) as SaveFile : blankSave(), online: false };
  }
}

export async function putSave(save: SaveFile): Promise<SaveFile> {
  const snapshot = { ...save } as Record<string, unknown>;
  delete snapshot.revision; delete snapshot.savedAt;
  try {
    const response = await fetch("/api/saves/default", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: save.revision, snapshot }) });
    if (!response.ok) throw new Error(`Save failed (${response.status})`);
    const result = await response.json() as { revision: number; savedAt: string; snapshot?: SaveFile };
    const authoritative = result.snapshot ?? { ...save, revision: result.revision, savedAt: result.savedAt };
    localStorage.setItem("hanzi-defender-emergency-save", JSON.stringify(authoritative));
    return authoritative;
  } catch (error) {
    localStorage.setItem("hanzi-defender-emergency-save", JSON.stringify(save));
    throw error;
  }
}
