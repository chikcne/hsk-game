import { describe, expect, it } from "vitest";
import { generateChoices } from "../../src/domain/session/choices";
import { createDemoDeck } from "../../src/client/data/demoDeck";
describe("meaning choices", () => { it("makes deterministic safe eight-key choices", () => { const deck = createDemoDeck("hsk-1"); const first = generateChoices(deck, deck.words[0]!, "enemy-1"); const again = generateChoices(deck, deck.words[0]!, "enemy-1"); expect(first).toEqual(again); expect(first).toHaveLength(8); expect(first.filter((choice) => choice.correct)).toHaveLength(1); expect(new Set(first.map((choice) => choice.label)).size).toBe(8); }); });
