import type { RuleMatch } from './rule.types.js';
import type { Validator, Violation } from './validate.types.js';
import type { Logger } from './logger.types.js';

/**
 * Shape of the data object as it flows through the merge pipeline: every
 * field of `T` is present but may be `null` when neither a rule nor an LLM
 * provided a value.
 *
 * @typeParam T - Non-null target shape (typically `z.infer<Schema>`).
 */
export type ExtractedData<T> = { [K in keyof T]: T[K] | null };

/**
 * Post-merge transformation. Normalizers run in declared order after the
 * per-field fusion, receive the merged data plus the original `content`,
 * and return the updated data. They are allowed to mutate their input; the
 * merge pipeline shallow-copies once before invoking them.
 *
 * @typeParam T - Non-null target shape the extraction is aiming for.
 */
export type Normalizer<T> = (
  data: ExtractedData<T>,
  content: string,
) => ExtractedData<T>;

/**
 * Behavior overrides accepted by the top-level merge. Every field is
 * optional; defaults match rules-only mode with no normalization and no
 * validators.
 *
 * @typeParam T - Non-null target shape (`z.infer<Schema>`).
 */
export type MergeApplyOptions<T> = {
  /** Overrides forwarded to every field-level fusion call. */
  policy?: Partial<FieldMergePolicy>;
  /** Transformations run in declared order after the per-field fusion. */
  normalizers?: Normalizer<T>[];
  /** Invariants run on the normalized data; their violations populate `validation`. */
  validators?: Validator<ExtractedData<T>>[];
  /** Logger propagated through the pipeline for warnings and fallbacks. */
  logger?: Logger;
};

/**
 * Strategy applied when the rule and the LLM disagree on a field value.
 *
 * - `'flag'` — keep the rule value, lower its confidence, and record a
 *   {@link Conflict} so the caller can review the disagreement.
 * - `'prefer-rule'` — silently keep the rule value and its confidence.
 * - `'prefer-llm'` — silently keep the LLM value and the default LLM
 *   confidence.
 */
export type ConflictStrategy = 'flag' | 'prefer-rule' | 'prefer-llm';

/**
 * A disagreement between a rule match and an LLM value for the same field.
 * Produced only when the resolution strategy is `'flag'`.
 */
export type Conflict = {
  /** Name of the schema field where the disagreement occurred. */
  field: string;
  /** Value proposed by the rule. */
  ruleValue: unknown;
  /** Confidence the rule associated with its value, in `[0, 1]`. */
  ruleConfidence: number;
  /** Value proposed by the LLM. */
  llmValue: unknown;
};

/**
 * Outcome of fusing a single field from a rule match and an LLM value.
 *
 * @typeParam T - Type of the merged value.
 */
export type FieldMergeResult<T> = {
  /** The value kept for the field, or `null` if neither source provided one. */
  value: T | null;
  /** Confidence associated with `value`, in `[0, 1]`, or `null` if absent. */
  confidence: number | null;
  /** Conflict record when the strategy flagged a disagreement; `undefined` otherwise. */
  conflict: Conflict | undefined;
};

/**
 * Equality check used by {@link merge.field} to decide whether a rule match
 * and an LLM value "agree". Return `true` when the two values should be
 * treated as equivalent.
 */
export type FieldCompare = (a: unknown, b: unknown) => boolean;

/**
 * Policy that drives {@link merge.field} when a rule match and an LLM value
 * are both available.
 */
export type FieldMergePolicy = {
  /** How to resolve a disagreement between the rule and the LLM. */
  strategy: ConflictStrategy;
  /** Confidence applied to a value coming solely from the LLM. */
  defaultLlmConfidence: number;
  /** Confidence applied to the rule value when the strategy flags a conflict. */
  flaggedConfidence: number;
  /** Confidence applied when the rule and the LLM agree (per {@link FieldCompare}). */
  agreementConfidence: number;
  /** Equality check used to detect agreement between the rule and the LLM. */
  compare: FieldCompare;
};

/**
 * Re-exported from `rule.types` so consumers building {@link FieldMergeResult}
 * or implementing a custom merge on top of {@link FieldMergePolicy} only need
 * to import from `merge.types`.
 */
export type { RuleMatch };

/**
 * The raw output of an LLM call, restricted to the fields that the prompt
 * asked about. Consumers normally build this through the provider adapters
 * but it can also be injected manually in tests or custom pipelines.
 */
export type LlmResult = {
  /** Field values returned by the LLM. Unknown fields are preserved and filtered later against the schema. */
  values: Record<string, unknown>;
  /** Optional warnings produced while parsing the LLM response (dropped fields, invalid JSON, ...). */
  warnings?: string[];
};

/**
 * Aggregate outcome of every validator attached to an extractor.
 */
export type ValidationResult = {
  /** `false` as soon as any violation has severity `'error'`. */
  valid: boolean;
  /** Every violation produced by the validators, errors and warnings alike. */
  violations: Violation[];
};

/**
 * Runtime metadata about an extraction run, useful for observability.
 */
export type ExtractionMeta = {
  /** Number of rule matches that produced a value kept by {@link merge.apply}. */
  rulesMatched: number;
  /** Whether an LLM call was issued during this extraction. */
  llmCalled: boolean;
  /** Wall-clock duration of the extraction, in milliseconds. */
  durationMs: number;
};

/**
 * Final shape returned by {@link merge.apply}. Every schema field is present
 * in `data` and `confidence`; missing fields hold `null` on both sides and
 * also appear in {@link ExtractionResult.missing}.
 *
 * @typeParam T - Shape of the target data object inferred from a Zod schema.
 */
export type ExtractionResult<T> = {
  /** Merged values per field; `null` when neither the rules nor the LLM provided a value. */
  data: ExtractedData<T>;
  /** Confidence per field in `[0, 1]`, or `null` when the field is missing. */
  confidence: { [K in keyof T]: number | null };
  /** Disagreements recorded by the `'flag'` strategy during per-field fusion. */
  conflicts: Conflict[];
  /** Fields for which no value could be produced. */
  missing: (keyof T)[];
  /** Aggregate output of the validators. */
  validation: ValidationResult;
  /** Runtime metadata about this extraction. */
  meta: ExtractionMeta;
};
