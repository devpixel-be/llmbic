/**
 * Deep structural equality tuned for the merge pipeline's needs.
 *
 * Called once per (normalizer, field) pair, so the common cases - primitives,
 * `null`/`undefined`, short arrays of primitives, small plain objects - are
 * handled inline without recursion into helper functions. Dates, Maps, Sets
 * and custom classes fall through to a `JSON.stringify` compare. Circular
 * structures downgrade to reference equality: the recursive compare is
 * wrapped in a `try/catch`, so a `RangeError` from unbounded recursion or a
 * `TypeError` from `JSON.stringify` on a cycle falls through to `false`
 * (reference equality was already checked up front).
 *
 * Deliberately *not* exported from the package root: it's an internal helper
 * for {@link runNormalizers} and callers should not rely on its semantics.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns `true` when `a` and `b` are structurally equal.
 */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  try {
    return deepEquals(a, b);
  } catch {
    return false;
  }
}

function deepEquals(a: object, b: object): boolean {
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    return false;
  }
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!valueEquals(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const aProto = Object.getPrototypeOf(a);
  const bProto = Object.getPrototypeOf(b);
  const aPlain = aProto === Object.prototype || aProto === null;
  const bPlain = bProto === Object.prototype || bProto === null;
  if (aPlain && bPlain) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!valueEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
        return false;
      }
    }
    return true;
  }

  return JSON.stringify(a) === JSON.stringify(b);
}
