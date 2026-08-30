function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}
