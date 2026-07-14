/** Deep-merge semantics used across the manifest layer:
 *  - plain objects merge recursively;
 *  - arrays and scalars are replaced by the overlay;
 *  - a `null` value in the overlay deletes the key from the result
 *    (used by project overlays to disable inherited entries).
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => clone(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = clone(v);
    }
    return out as T;
  }
  return value;
}

export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return clone(base);
  if (!isPlainObject(base) || !isPlainObject(overlay)) return clone(overlay);
  const out: Record<string, unknown> = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

/** Remove `null` entries that survived a merge (e.g. a deletion targeting a
 *  key that never existed in any lower layer). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripNulls(v));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}
