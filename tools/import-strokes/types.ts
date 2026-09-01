import type { DeckId } from "../../src/shared/constants";

export type StrokePoint = [number, number];

export type StrokeCharacterData = {
  strokes: string[];
  medians: StrokePoint[][];
};

export type StrokeBundle = {
  schemaVersion: 1;
  sourceCommit: string;
  sourceSha256: string;
  characters: Record<string, StrokeCharacterData>;
};

export type StrokeOrderOverride = {
  issue: string;
  note: string;
  strokeOrder: number[];
};

export type StrokeOverrides = Record<string, StrokeOrderOverride>;

export type StrokeBundleManifest = {
  schemaVersion: 1;
  source: {
    repository: string;
    commit: string;
    graphicsSha256: string;
    commitDate: string;
  };
  extractionDate: string;
  uniqueCharacterCount: number;
  appliedOverrides: Array<{ character: string; issue: string; note: string }>;
  qualityReviews: Array<{ characters: string[]; issue: string; decision: string }>;
  bundles: Record<DeckId, { characterCount: number; bytes: number; sha256: string }>;
};
