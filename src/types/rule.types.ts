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
 */
export type ExtractionRule = {
  /** Name of the schema field this rule targets. */
  field: string;
  /** Inspects `content` and returns a match, or `null` if nothing was found. */
  extract: (content: string) => RuleMatch<unknown> | null;
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
  /** Schema fields for which no rule produced a valid value. */
  missing: (keyof T)[];
};
