/** Pretty JSON in `stableJson`'s shape (two-space indent, trailing newline)
 * but preserving object-key insertion order. The keyed curriculum manifest
 * encodes the curriculum order as its key insertion order, so sorting keys —
 * as `stableJson` deliberately does for every other artifact — would destroy
 * the one thing this file exists to carry. Card IDs are 24-hex strings and
 * therefore never JS array indices, so `JSON.stringify`/`JSON.parse` round-
 * trip the authored order exactly. */
export function orderedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
