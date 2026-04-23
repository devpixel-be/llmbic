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
 * Normalizers can optionally accept a `context` argument: an opaque,
 * caller-defined value forwarded verbatim by `merge.apply` /
 * `Extractor.extract` - the same per-call context the extractor's rules
 * receive. Typical use is to gate cross-field fix-ups on tenant-specific
 * configuration (e.g. a source URL, a feature flag). `TContext` defaults to
 * `unknown` so context-unaware normalizers stay assignable to arrays typed
 * with any context.
 *
 * @typeParam T - Non-null target shape the extraction is aiming for.
 * @typeParam TContext - Shape of the optional per-call context forwarded to
 *   the normalizer. Defaults to `unknown`.
 */
export type Normalizer<T, TContext = unknown> = (
  data: ExtractedData<T>,
  content: string,
  context?: TContext,
) => ExtractedData<T>;

/**
 * Behavior overrides accepted by the top-level merge. Every field is
 * optional; defaults match rules-only mode with no normalization and no
 * validators.
 *
 * @typeParam T - Non-null target shape (`z.infer<Schema>`).
 * @typeParam TContext - Shape of the optional per-call context forwarded to
 *   every normalizer. Defaults to `unknown`.
 */
export type MergeApplyOptions<T, TContext = unknown> = {
  /** Overrides forwarded to every field-level fusion call. */
  policy?: Partial<FieldMergePolicy>;
  /**
   * Per-field policy overrides applied on top of `policy`. Precedence:
   * library defaults < `policy` < `policyByField[field]`. Fields absent from
   * the map fall back to `policy` alone.
   */
  policyByField?: { [K in keyof T]?: Partial<FieldMergePolicy> };
  /** Transformations run in declared order after the per-field fusion. */
  normalizers?: Normalizer<T, TContext>[];
  /** Invariants run on the normalized data; their violations populate `validation`. */
  validators?: Validator<ExtractedData<T>>[];
  /** Logger propagated through the pipeline for warnings and fallbacks. */
  logger?: Logger;
};

/**
 * Strategy applied when the rule and the LLM disagree on a field value.
 *
 * - `'flag'` - keep the rule value, lower its confidence, and record a
 *   {@link Conflict} so the caller can review the disagreement.
 * - `'prefer-rule'` - silently keep the rule value and its confidence.
 * - `'prefer-llm'` - silently keep the LLM value and the default LLM
 *   confidence.
 */
export type ConflictStrategy = 'flag' | 'prefer-rule' | 'prefer-llm';

/**
 * Origin of the value kept for a field after fusion. Each variant carries the
 * `ruleId` of the deterministic rule involved when applicable, so consumers
 * can attribute extracted values back to the exact rule that produced them.
 *
 * - `'rule'`: only the rule produced a value, or the rule won under
 *   `'prefer-rule'`.
 * - `'llm'`: only the LLM produced a value, or the LLM won under
 *   `'prefer-llm'`.
 * - `'agreement'`: rule and LLM produced equivalent values per the policy's
 *   `compare` callback. `ruleId` points to the rule that matched.
 * - `'flag'`: rule and LLM disagreed under the `'flag'` strategy. The rule
 *   value is kept; `ruleId` identifies the rule.
 */
export type FieldSource =
  | { kind: 'rule'; ruleId: string }
  | { kind: 'llm' }
  | { kind: 'agreement'; ruleId: string }
  | { kind: 'flag'; ruleId: string };

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
 * A single mutation observed while running a {@link Normalizer}. One entry is
 * produced per (normalizer, field) pair whose value changed during that
 * normalizer's pass. Consumers use this signal to audit post-fusion
 * transformations, diagnose regressions after a normalizer change, or surface
 * "what did the pipeline actually do" in observability dashboards.
 *
 * `before` and `after` are recorded verbatim: no diffing, no deep-cloning,
 * no semantic interpretation. The caller interprets them (display, JSON
 * serialization, audit log, ...).
 *
 * @typeParam T - Non-null target shape the extraction is aiming for.
 */
export type NormalizerMutation<T> = {
  /**
   * Identifier of the normalizer that produced the mutation. Resolution
   * order: `fn.id` (string property) -> `fn.name` -> `'anonymous'`. Use
   * {@link defineNormalizer} (exported from the package root) to attach a
   * stable id to an arrow function.
   */
  normalizerId: string;
  /** Schema field whose value changed. */
  field: keyof T;
  /** Value observed by the normalizer for that field. */
  before: unknown;
  /** Value the normalizer wrote for that field. */
  after: unknown;
  /**
   * Zero-based index of the normalizer in the configured pipeline. Useful
   * when a field is mutated by several normalizers in sequence: the entry
   * with the smallest `step` ran first.
   */
  step: number;
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
  /**
   * Origin of the value kept for each field, or `null` for missing fields.
   * Use it to attribute extractions back to the rule that produced them, to
   * detect agreement between rules and LLM, or to spot flagged conflicts.
   */
  sources: { [K in keyof T]: FieldSource | null };
  /** Disagreements recorded by the `'flag'` strategy during per-field fusion. */
  conflicts: Conflict[];
  /** Fields for which no value could be produced. */
  missing: (keyof T)[];
  /**
   * Mutations observed while running the configured normalizers, in the order
   * they occurred. One entry per `(normalizer, field)` where the field's
   * value changed. Empty when no normalizers ran or none mutated any field.
   *
   * Orthogonal to {@link ExtractionResult.sources}: `sources[field]` keeps
   * pointing at the post-fusion origin even after a normalizer rewrites
   * the value; this array is where post-fusion rewrites are tracked.
   */
  normalizerMutations: NormalizerMutation<T>[];
  /** Aggregate output of the validators. */
  validation: ValidationResult;
  /** Runtime metadata about this extraction. */
  meta: ExtractionMeta;
};
