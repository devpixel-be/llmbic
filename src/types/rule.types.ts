/**
 * The result of a single deterministic extraction rule: a candidate value
 * paired with a confidence score in the `[0, 1]` range.
 *
 * @typeParam T - Type of the extracted value.
 */
export type RuleMatch<T> = {
  /** The extracted value proposed by the rule. */
  value: T;
  /** Confidence score in `[0, 1]`; higher beats lower on field collisions. */
  confidence: number;
};

/**
 * A deterministic rule that tries to extract a single schema field from raw
 * content. `extract` returns `null` when the rule does not apply.
 *
 * Rules can optionally accept a `context` argument: an opaque, caller-defined
 * value forwarded verbatim by `rule.apply` / `Extractor.extract`. Typical use
 * is to expose per-call metadata (locale, tenant-specific configuration,
 * feature flags) rules need to decide whether they apply. `TContext`
 * defaults to `unknown` so context-unaware rules stay assignable to arrays
 * typed with any context.
 *
 * @typeParam TContext - Shape of the optional per-call context forwarded to
 *   `extract`. Defaults to `unknown`.
 */
export type ExtractionRule<TContext = unknown> = {
  /**
   * Stable identifier surfaced in `ExtractionResult.sources` when this rule
   * produces the kept value. Optional: when omitted, `rule.apply` assigns
   * `${field}#${declarationIndex}` based on the rule's position in the
   * `rules` array.
   */
  id?: string;
  /** Name of the schema field this rule targets. */
  field: string;
  /**
   * Inspects `content` - and optionally a caller-provided `context` -
   * and returns a match, or `null` if nothing was found. `context` is
   * forwarded verbatim by `rule.apply` / `Extractor.extract` and left
   * `undefined` when the caller passes no context.
   */
  extract: (content: string, context?: TContext) => RuleMatch<unknown> | null;
};

/**
 * The output of the rules pass. Contains the values that deterministic rules
 * managed to extract, the confidence score per field, and the list of schema
 * fields still missing (to be delegated to an LLM or left empty).
 *
 * @typeParam T - Shape of the target data object inferred from a Zod schema.
 */
export type RulesResult<T> = {
  /** Values successfully extracted by rules, keyed by field name. */
  values: Partial<T>;
  /** Confidence score per extracted field, in `[0, 1]`. */
  confidence: Partial<Record<keyof T, number>>;
  /**
   * Identifier of the winning rule per extracted field. Always populated by
   * {@link rule.apply}: either the rule's declared `id` or
   * `${field}#${declarationIndex}` from the source `rules` array. Optional
   * on the type for back-compat with callers who build {@link RulesResult}
   * by hand; consumers (including {@link merge.apply}) tolerate its absence
   * and surface an empty `ruleId` in {@link FieldSource} when missing.
   */
  sourceIds?: Partial<Record<keyof T, string>>;
  /** Schema fields for which no rule produced a valid value. */
  missing: (keyof T)[];
};
