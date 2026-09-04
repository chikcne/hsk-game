/** Cross-grade identity: review keys scope a word ID by its grade so
 * identical source IDs cannot collide. The same key format identifies words
 * in the `acquired_words` table and in the active Relearn session. */
export function reviewWordKey(deckId: string, wordId: string): string {
  return `${deckId}:${wordId}`;
}

export function reviewWordIdOf(key: string): { deckId: string; wordId: string } {
  const separator = key.indexOf(":");
  if (separator <= 0) throw new Error(`Invalid review word key: ${key}`);
  return { deckId: key.slice(0, separator), wordId: key.slice(separator + 1) };
}
