import { readFileSync } from "node:fs";
import { Data } from "effect";
import { parse as parseYaml } from "yaml";
import { BattleConfigSchema, type BattleConfig } from "../shared/battle";

/** config/battle.yaml is missing, unparseable, or does not strictly satisfy
 * the battle configuration contract. Fatal at startup — never defaulted. */
export class BattleConfigError extends Data.TaggedError("BattleConfigError")<{
  readonly path: string;
  readonly message: string;
}> {}

/** The exact key set config/battle.yaml may carry, nested shape included.
 * Anything missing, extra, or renamed is an operator error. */
const EXPECTED_KEYS = {
  root: ["learningSlots", "boundaries", "masteryDelta", "masteryCurve", "relief", "curve", "asymptotes"],
  boundaries: ["lowMax", "developingMax"],
  masteryCurve: ["maxMs", "maxGain", "midMs", "midGain", "floorMs", "floorGain", "secondChanceGain"],
  relief: ["correct", "secondChance"],
  curve: ["midpoint", "shape"],
  asymptotes: ["low", "developing", "mastered"],
} as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkKeySet(path: string, value: unknown, expected: readonly string[], where: string): void {
  if (!isPlainObject(value)) {
    throw new BattleConfigError({ path, message: `${where} must be a mapping` });
  }
  const keys = Object.keys(value);
  for (const key of expected) {
    if (!(key in value)) throw new BattleConfigError({ path, message: `${where} is missing required key "${key}"` });
  }
  for (const key of keys) {
    if (!expected.includes(key)) throw new BattleConfigError({ path, message: `${where} has unknown key "${key}"` });
  }
}

/**
 * Reads and strictly validates the battle tuning YAML exactly once at server
 * startup. The file must carry precisely the documented key set (no extras,
 * no renames) and satisfy every range/invariant of BattleConfigSchema — the
 * asymptotic shares must sum to 1, the category boundaries must be ordered,
 * and the mastery-curve anchor times must strictly increase.
 * Any violation is a fatal BattleConfigError; there is no default fallback.
 */
export function loadBattleConfig(path: string): BattleConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new BattleConfigError({ path, message: `Cannot read battle configuration: ${String(cause)}` });
  }

  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (cause) {
    throw new BattleConfigError({ path, message: `Battle configuration is not valid YAML: ${String(cause)}` });
  }
  if (document === null || document === undefined) {
    throw new BattleConfigError({ path, message: "Battle configuration is empty" });
  }

  try {
    checkKeySet(path, document, EXPECTED_KEYS.root, "battle configuration");
    checkKeySet(path, (document as Record<string, unknown>).boundaries, EXPECTED_KEYS.boundaries, "boundaries");
    checkKeySet(path, (document as Record<string, unknown>).masteryCurve, EXPECTED_KEYS.masteryCurve, "masteryCurve");
    checkKeySet(path, (document as Record<string, unknown>).relief, EXPECTED_KEYS.relief, "relief");
    checkKeySet(path, (document as Record<string, unknown>).curve, EXPECTED_KEYS.curve, "curve");
    checkKeySet(path, (document as Record<string, unknown>).asymptotes, EXPECTED_KEYS.asymptotes, "asymptotes");
  } catch (error) {
    if (error instanceof BattleConfigError) throw error;
    throw new BattleConfigError({ path, message: `Battle configuration is malformed: ${String(error)}` });
  }

  const parsed = BattleConfigSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new BattleConfigError({ path, message: `Battle configuration failed validation: ${issues}` });
  }
  return parsed.data;
}
