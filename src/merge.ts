import type { z } from 'zod';
import type { Logger } from './types/logger.types.js';
import type { RuleMatch, RulesResult } from './types/rule.types.js';
import type { Violation } from './types/validate.types.js';
import type {
  Conflict,
  ExtractedData,
  ExtractionResult,
  FieldMergePolicy,
  FieldMergeResult,
  FieldSource,
  LlmResult,
  MergeApplyOptions,
  Normalizer,
  NormalizerMutation,
} from './types/merge.types.js';
import { valueEquals } from './utils/value-equals.js';
import { resolveNormalizerId } from './utils/normalizer-id.js';

type FusionOutcome<T> = {
  data: ExtractedData<T>;
  confidence: { [K in keyof T]: number | null };
  sources: { [K in keyof T]: FieldSource | null };
  conflicts: Conflict[];
  missing: (keyof T)[];
  rulesMatched: number;
};

/**
 * Walk every schema field, build the {@link RuleMatch} if rules produced a
 * value, fuse it with the LLM candidate via {@link merge.field}, and collect
 * per-field outcomes. Invoked once at the top of {@link merge.apply}.
 */
function fuseAllFields<T>(
  schemaKeys: (keyof T)[],
  rulesResult: RulesResult<T>,
  llmResult: LlmResult | null,
  policy: Partial<FieldMergePolicy> | undefined,
  policyByField: { [K in keyof T]?: Partial<FieldMergePolicy> } | undefined,
  logger: Logger | undefined,
): FusionOutcome<T> {
  const data = {} as ExtractedData<T>;
  const confidence = {} as { [K in keyof T]: number | null };
  const sources = {} as { [K in keyof T]: FieldSource | null };
  const conflicts: Conflict[] = [];
  const missing: (keyof T)[] = [];
  let rulesMatched = 0;

  for (const field of schemaKeys) {
    const hasRuleValue = field in rulesResult.values;
    // hasRuleValue implies confidence[field] is defined - rule.apply only writes
    // to `confidence` when it also writes to `values`.
    const ruleMatch: RuleMatch<unknown> | null = hasRuleValue
      ? {
          value: rulesResult.values[field],
          confidence: rulesResult.confidence[field] as number,
        }
      : null;
    if (hasRuleValue) {
      rulesMatched += 1;
    }

    const llmValue = llmResult?.values[field as string] ?? null;

    const fieldOverride = policyByField?.[field];
    const resolvedPolicy =
      fieldOverride === undefined ? policy : { ...policy, ...fieldOverride };
    const ruleId = rulesResult.sourceIds?.[field];

    const fused = merge.field(field as string, ruleMatch, llmValue, resolvedPolicy, logger);

    data[field] = fused.value as T[keyof T] | null;
    confidence[field] = fused.confidence;
    sources[field] = deriveSource(fused, ruleMatch, llmValue, resolvedPolicy, ruleId);
    if (fused.conflict !== undefined) {
      conflicts.push(fused.conflict);
    }
    if (fused.value === null) {
      missing.push(field);
    }
  }

  return { data, confidence, sources, conflicts, missing, rulesMatched };
}

/**
 * Classify the origin of a fused value into a {@link FieldSource}. Mirrors
 * the decision tree of {@link merge.field} without re-running the strategy:
 *
 * - rule alone -> `'rule'`
 * - LLM alone -> `'llm'`
 * - both null -> `null`
 * - both present, conflict recorded -> `'flag'` (only the `'flag'` strategy
 *   produces a conflict)
 * - both present, no conflict, kept value differs from the rule -> `'llm'`
 *   (only `'prefer-llm'` reaches this case)
 * - both present, no conflict, kept value matches the rule -> `'agreement'`
 *   when the policy's `compare` returns true, else `'rule'` (`'prefer-rule'`
 *   silent path)
 *
 * `ruleId` is `''` when the rule provided no declared id and `rule.apply`
 * was bypassed by the caller.
 */
function deriveSource(
  fused: FieldMergeResult<unknown>,
  ruleMatch: RuleMatch<unknown> | null,
  llmValue: unknown,
  policy: Partial<FieldMergePolicy> | undefined,
  ruleId: string | undefined,
): FieldSource | null {
  if (fused.value === null) {
    return null;
  }
  const id = ruleId ?? '';
  if (ruleMatch === null) {
    return { kind: 'llm' };
  }
  if (llmValue === null || llmValue === undefined) {
    return { kind: 'rule', ruleId: id };
  }
  if (fused.conflict !== undefined) {
    return { kind: 'flag', ruleId: id };
  }
  if (fused.value !== ruleMatch.value) {
    return { kind: 'llm' };
  }
  const compare = policy?.compare ?? merge.defaultFieldPolicy.compare;
  return compare(ruleMatch.value, llmValue)
    ? { kind: 'agreement', ruleId: id }
    : { kind: 'rule', ruleId: id };
}

/**
 * Apply every configured {@link Normalizer} to the merged data in declared
 * order and track per-key mutations along the way. Normalizers may mutate
 * their argument; the returned reference is what the rest of the pipeline
 * observes. The caller-provided `context` is forwarded verbatim to every
 * normalizer (left `undefined` when the caller passed none).
 *
 * For each normalizer, a shallow snapshot of the incoming object is taken,
 * the normalizer is invoked, and the diff is computed over the union of
 * keys present in either snapshot - covering both schema fields and the
 * extra-schema "derived field" keys llmbic tolerates at runtime. Keys added
 * by the normalizer surface as `before: undefined`; keys deleted surface
 * as `after: undefined`. Equality is structural (see `valueEquals`) so an
 * arrow that returns `{ ...data }` without actually changing any value
 * does not generate spurious entries.
 */
function runNormalizers<T, TContext>(
  data: ExtractedData<T>,
  normalizers: Normalizer<T, TContext>[] | undefined,
  content: string,
  context: TContext | undefined,
): { data: ExtractedData<T>; mutations: NormalizerMutation<T>[] } {
  const mutations: NormalizerMutation<T>[] = [];
  let current = data;
  const list = normalizers ?? [];

  for (let step = 0; step < list.length; step++) {
    const normalizer = list[step]!;
    const beforeSnapshot = { ...(current as Record<string, unknown>) };
    current = normalizer(current, content, context);
    const normalizerId = resolveNormalizerId(normalizer);

    const afterRecord = current as Record<string, unknown>;
    const allKeys = new Set<string>([
      ...Object.keys(beforeSnapshot),
      ...Object.keys(afterRecord),
    ]);

    for (const key of allKeys) {
      const before = beforeSnapshot[key];
      const after = afterRecord[key];
      if (!valueEquals(before, after)) {
        mutations.push({
          normalizerId,
          field: key as keyof T | string,
          before,
          after,
          step,
        });
      }
    }
  }
  return { data: current, mutations };
}

/**
 * Produce the violation list for the normalized data: first the Zod schema
 * re-validation (skipping fields already tracked in `missing`), then every
 * configured validator.
 */
function collectViolations<T>(
  schema: z.ZodObject<z.ZodRawShape>,
  normalized: ExtractedData<T>,
  missing: (keyof T)[],
  validators: MergeApplyOptions<T>['validators'],
): Violation[] {
  const violations: Violation[] = [];
  const missingSet = new Set(missing as string[]);
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [firstPath] = issue.path;
      const field = typeof firstPath === 'string' ? firstPath : undefined;
      if (field !== undefined && missingSet.has(field)) {
        continue;
      }
      violations.push({
        field,
        rule: 'schema',
        message: issue.message,
        severity: 'error',
      });
    }
  }
  for (const validator of validators ?? []) {
    violations.push(...validator(normalized));
  }
  return violations;
}

/**
 * Field-level and object-level merge primitives.
 *
 * For now, only {@link merge.field} is exposed; the top-level object merge
 * will be added in a later slice.
 */
export const merge = {
  /**
   * Library defaults applied by {@link merge.field} when the caller omits
   * one or more policy fields. Exposed so consumers can reference or spread
   * them (e.g. `{ ...merge.defaultFieldPolicy, strategy: 'prefer-llm' }`).
   *
   * See {@link FieldMergePolicy} for the meaning of each field.
   */
  defaultFieldPolicy: {
    /** See {@link FieldMergePolicy.strategy}. */
    strategy: 'flag',
    /** See {@link FieldMergePolicy.defaultLlmConfidence}. */
    defaultLlmConfidence: 0.7,
    /** See {@link FieldMergePolicy.flaggedConfidence}. */
    flaggedConfidence: 0.3,
    /** See {@link FieldMergePolicy.agreementConfidence}. */
    agreementConfidence: 1.0,
    /** See {@link FieldMergePolicy.compare}. Case-insensitive for strings, strict equality otherwise. */
    compare: (a: unknown, b: unknown): boolean => {
      if (typeof a === 'string' && typeof b === 'string') {
        return a.toLowerCase() === b.toLowerCase();
      }
      return a === b;
    },
  } satisfies FieldMergePolicy,

  /**
   * Fuse a rule match and an LLM value for a single field, following the
   * provided policy. Returns the kept value, its confidence, and a conflict
   * record if the strategy flagged a disagreement.
   *
   * Any policy field omitted from `policy` falls back to
   * {@link merge.defaultFieldPolicy}.
   *
   * Decision table (in order): rule-only, llm-only, both-null, agree,
   * prefer-rule, prefer-llm, flag (default fallback).
   *
   * @typeParam T - Type of the rule value.
   * @param field - Name of the field being merged.
   * @param ruleMatch - Value proposed by a deterministic rule, or `null` if none.
   * @param llmValue - Value proposed by the LLM, or `null` if none. Cast to `T`
   *   without runtime type-check - callers that expose `merge.field` via
   *   `merge.apply` rely on the final Zod re-validation to reject invalid LLM values.
   * @param policy - Optional strategy and confidence overrides.
   * @param logger - Optional logger notified of unexpected runtime situations
   *   (e.g. an unknown strategy slipped past the type system).
   */
  field<T>(
    field: string,
    ruleMatch: RuleMatch<T> | null,
    llmValue: unknown,
    policy?: Partial<FieldMergePolicy>,
    logger?: Logger,
  ): FieldMergeResult<T> {
    const fullPolicy: FieldMergePolicy = { ...merge.defaultFieldPolicy, ...policy };
    const normalizedLlm = llmValue ?? null;

    if (ruleMatch !== null && normalizedLlm === null) {
      return {
        value: ruleMatch.value,
        confidence: ruleMatch.confidence,
        conflict: undefined,
      };
    }

    if (ruleMatch === null && normalizedLlm !== null) {
      return {
        value: normalizedLlm as T,
        confidence: fullPolicy.defaultLlmConfidence,
        conflict: undefined,
      };
    }

    if (ruleMatch === null || normalizedLlm === null) {
      return { value: null, confidence: null, conflict: undefined };
    }

    if (fullPolicy.compare(ruleMatch.value, normalizedLlm)) {
      return {
        value: ruleMatch.value,
        confidence: fullPolicy.agreementConfidence,
        conflict: undefined,
      };
    }

    if (fullPolicy.strategy === 'prefer-rule') {
      return {
        value: ruleMatch.value,
        confidence: ruleMatch.confidence,
        conflict: undefined,
      };
    }
    if (fullPolicy.strategy === 'prefer-llm') {
      return {
        value: normalizedLlm as T,
        confidence: fullPolicy.defaultLlmConfidence,
        conflict: undefined,
      };
    }
    if (fullPolicy.strategy !== 'flag') {
      logger?.warn('unknown conflict strategy, falling back to flag', {
        strategy: fullPolicy.strategy,
        field,
      });
    }
    return {
      value: ruleMatch.value,
      confidence: fullPolicy.flaggedConfidence,
      conflict: {
        field,
        ruleValue: ruleMatch.value,
        ruleConfidence: ruleMatch.confidence,
        llmValue: normalizedLlm,
      },
    };
  },

  /**
   * Walk every field of `schema`, fuse the rules pass result with the LLM
   * result via {@link merge.field}, and produce a typed
   * {@link ExtractionResult}.
   *
   * Passing `llmResult = null` runs in rules-only mode: every field keeps
   * whatever the rules produced and `meta.llmCalled` is `false`.
   *
   * Orchestration only - the three phases (fusion, normalization, validation)
   * each live in their own private helper above.
   *
   * Runtime fields of `meta` (`durationMs`, `tokensUsed`) are populated by
   * later slices; for now `durationMs` is `0`.
   *
   * @typeParam S - A Zod object schema.
   * @typeParam TContext - Shape of the optional context forwarded to every
   *   normalizer. Defaults to `unknown`.
   * @param schema - Zod object schema describing the target data shape.
   * @param rulesResult - Output of {@link rule.apply} for the same schema.
   * @param llmResult - Parsed LLM response, or `null` for rules-only mode.
   * @param content - Original text the rules and LLM were derived from; forwarded to normalizers so they can cross-reference the source.
   * @param options - Optional behavior overrides (policy, normalizers, validators, logger).
   * @param context - Optional caller-defined value forwarded to every normalizer's third argument. Left `undefined` when omitted.
   */
  apply<S extends z.ZodObject<z.ZodRawShape>, TContext = unknown>(
    schema: S,
    rulesResult: RulesResult<z.infer<S>>,
    llmResult: LlmResult | null,
    content: string,
    options?: MergeApplyOptions<z.infer<S>, TContext>,
    context?: TContext,
  ): ExtractionResult<z.infer<S>> {
    type Data = z.infer<S>;
    const schemaKeys = Object.keys(schema.shape) as (keyof Data)[];

    const fusion = fuseAllFields<Data>(
      schemaKeys,
      rulesResult,
      llmResult,
      options?.policy,
      options?.policyByField,
      options?.logger,
    );

    const normalized = runNormalizers(
      fusion.data,
      options?.normalizers,
      content,
      context,
    );

    const violations = collectViolations<Data>(
      schema,
      normalized.data,
      fusion.missing,
      options?.validators,
    );
    const valid = !violations.some((v) => v.severity === 'error');

    return {
      data: normalized.data,
      confidence: fusion.confidence,
      sources: fusion.sources,
      conflicts: fusion.conflicts,
      missing: fusion.missing,
      normalizerMutations: normalized.mutations,
      validation: { valid, violations },
      meta: {
        rulesMatched: fusion.rulesMatched,
        llmCalled: llmResult !== null,
        durationMs: 0,
      },
    };
  },
};

/**
 * Ergonomic helper to attach a stable `id` to a normalizer. Useful for arrow
 * functions which otherwise resolve to `'anonymous'` in
 * {@link NormalizerMutation.normalizerId}.
 *
 * Equivalent to `Object.assign(fn, { id })` with proper typings. The returned
 * value is a {@link Normalizer} that wraps `apply` verbatim and carries the
 * explicit `id`. `id` takes precedence over `fn.name` per the resolution
 * rules of {@link resolveNormalizerId}.
 *
 * @typeParam T - Non-null target shape of the extraction.
 * @typeParam TContext - Optional per-call context type. Defaults to `unknown`.
 * @param id - Non-empty stable identifier surfaced in mutation records.
 * @param apply - The normalizer body.
 */
export function defineNormalizer<T, TContext = unknown>(
  id: string,
  apply: Normalizer<T, TContext>,
): Normalizer<T, TContext> {
  const wrapped: Normalizer<T, TContext> = (data, content, context) =>
    apply(data, content, context);
  return Object.assign(wrapped, { id });
}
