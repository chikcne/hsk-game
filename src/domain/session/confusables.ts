import confusableJson from "../../shared/data/confusable-meanings.json";
import { DECK_IDS } from "../../shared/constants";

/** Which meanings a player confuses with one another. The data pipeline owns
 * src/shared/data/confusable-meanings.json: `{ schemaVersion: 1, groups:
 * [{ id, meaningKeys }] }`. Two meaning keys are confusable iff they share at
 * least one group; a key may appear in several groups. Review Mode demotes such
 * distractors to a last-resort tier instead of excluding them, because 说话
 * "to talk" is indistinguishable from 说's answer "to speak, to say" yet a hard
 * filter would starve small acquired pools (see designs/confusable_distractors.md §1, §2). */

const GROUPS_BY_MEANING_KEY = new Map<string, Set<string>>();

/** Rebuilds the meaningKey → group-ids index from a raw artifact. Deliberately
 * total: wrong schema version, non-array groups, non-string keys — every
 * malformed shape contributes nothing, so a broken artifact can only degrade to
 * "no confusables", never break the frame loop (§3). Each key is also indexed
 * under every `deckId:`-prefixed spelling, because Review Mode's merged deck
 * namespaces all meaning keys by grade (see src/client/data/reviewDeck.ts) while
 * the artifact is keyed on the raw compiled meaningKey — without the prefixed
 * spellings the demotion could never fire in the mode it ships for (§1). Also
 * the test seam for synthetic groups: the shipped file's contents are owned by
 * the data pipeline. */
export function indexConfusableGroups(artifact: unknown): void {
  GROUPS_BY_MEANING_KEY.clear();
  if (typeof artifact !== "object" || artifact === null) return;
  const { schemaVersion, groups } = artifact as { schemaVersion?: unknown; groups?: unknown };
  if (schemaVersion !== 1 || !Array.isArray(groups)) return;
  groups.forEach((group, groupIndex) => {
    if (typeof group !== "object" || group === null) return;
    const meaningKeys = (group as { meaningKeys?: unknown }).meaningKeys;
    if (!Array.isArray(meaningKeys)) return;
    const id = (group as { id?: unknown }).id;
    const groupId = typeof id === "string" ? id : `group-${groupIndex}`;
    for (const meaningKey of meaningKeys) {
      if (typeof meaningKey !== "string") continue;
      for (const spelling of [meaningKey, ...DECK_IDS.map((deckId) => `${deckId}:${meaningKey}`)]) {
        let ids = GROUPS_BY_MEANING_KEY.get(spelling);
        if (!ids) GROUPS_BY_MEANING_KEY.set(spelling, (ids = new Set()));
        ids.add(groupId);
      }
    }
  });
}

indexConfusableGroups(confusableJson);

/** True iff the two meaning keys share a confusable group. Two Map lookups and
 * one Set walk, no allocation: this sits inside the round-building filter that
 * runs on the battle loop's requestAnimationFrame thread (§2). */
export function areConfusableMeanings(a: string, b: string): boolean {
  if (a === b) return false;
  const left = GROUPS_BY_MEANING_KEY.get(a);
  const right = GROUPS_BY_MEANING_KEY.get(b);
  if (left === undefined || right === undefined) return false;
  for (const groupId of left) if (right.has(groupId)) return true;
  return false;
}
