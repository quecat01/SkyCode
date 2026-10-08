/**
 * Deterministic JSON serialization for comparing tool arguments.
 *
 * Shared by the repeated-action breaker (repeat-guard.ts) and recovery
 * resolution (recovery.ts), which both need "the same arguments" to mean
 * the same thing: equal after sorting object keys at every level, never a
 * fuzzy comparison.
 */
/**
 * Serializes a value deterministically, with object keys sorted at every
 * level, so two argument objects that differ only in key order compare
 * equal.
 *
 * @param {unknown} value - Arguments (or any JSON-compatible value).
 * @returns {string} Canonical JSON text.
 *
 * Side effects: none.
 */
export function canonicalizeArguments(
  value: unknown,
): string {
  const normalize = (
    item: unknown,
  ): unknown => {
    if (Array.isArray(item)) {
      return item.map(normalize);
    }

    if (
      typeof item === "object" &&
      item !== null
    ) {
      const record =
        item as Record<string, unknown>;

      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map(
            (key) => [
              key,
              normalize(record[key]),
            ],
          ),
      );
    }

    return item;
  };

  return JSON.stringify(
    normalize(value) ?? null,
  );
}
