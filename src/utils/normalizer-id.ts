/**
 * Resolve a stable identifier for a normalizer function:
 *
 * 1. An explicit `id` property (non-empty string) - set via
 *    `defineNormalizer(id, fn)` or any caller-owned convention.
 * 2. The function's `name` (non-empty) - regular named `function` or named
 *    arrow assigned to a `const` pick this up for free.
 * 3. `'anonymous'` fallback, used for arrow functions without a `name`.
 *
 * Kept private to the library; consumers read the resolved id off
 * {@link NormalizerMutation.normalizerId} rather than calling this helper.
 */
export function resolveNormalizerId(fn: unknown): string {
  if (typeof fn === 'function') {
    const explicit = (fn as { id?: unknown }).id;
    if (typeof explicit === 'string' && explicit.length > 0) {
      return explicit;
    }
    if (typeof fn.name === 'string' && fn.name.length > 0) {
      return fn.name;
    }
  }
  return 'anonymous';
}
