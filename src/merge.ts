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
  LlmResult,
  MergeApplyOptions,
  Normalizer,
} from './types/merge.types.js';

type FusionOutcome<T> = {
  data: ExtractedData<T>;
  confidence: { [K in keyof T]: number | null };
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
  logger: Logger | undefined,
): FusionOutcome<T> {
  const data = {} as ExtractedData<T>;
  const confidence = {} as { [K in keyof T]: number | null };
  const conflicts: Conflict[] = [];
  const missing: (keyof T)[] = [];
  let rulesMatched = 0;

  for (const field of schemaKeys) {
    const hasRuleValue = field in rulesResult.values;
    // hasRuleValue implies confidence[field] is defined — rule.apply only writes
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

    const fused = merge.field(field as string, ruleMatch, llmValue, policy, logger);

    data[field] = fused.value as T[keyof T] | null;
    confidence[field] = fused.confidence;
    if (fused.conflict !== undefined) {
      conflicts.push(fused.conflict);
    }
    if (fused.value === null) {
      missing.push(field);
    }
  }

  return { data, confidence, conflicts, missing, rulesMatched };
}

/**
 * Apply every configured {@link Normalizer} to the merged data in declared
 * order. Normalizers may mutate their argument; the returned reference is
 * what the rest of the pipeline observes.
 */
function runNormalizers<T>(
  data: ExtractedData<T>,
  normalizers: Normalizer<T>[] | undefined,
  content: string,
): ExtractedData<T> {
  let current = data;
  for (const normalizer of normalizers ?? []) {
    current = normalizer(current, content);
  }
  return current;
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
   *   without runtime type-check — callers that expose `merge.field` via
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
   * Orchestration only — the three phases (fusion, normalization, validation)
   * each live in their own private helper above.
   *
   * Runtime fields of `meta` (`durationMs`, `tokensUsed`) are populated by
   * later slices; for now `durationMs` is `0`.
   *
   * @typeParam S - A Zod object schema.
   * @param schema - Zod object schema describing the target data shape.
   * @param rulesResult - Output of {@link rule.apply} for the same schema.
   * @param llmResult - Parsed LLM response, or `null` for rules-only mode.
   * @param content - Original text the rules and LLM were derived from; forwarded to normalizers so they can cross-reference the source.
   * @param options - Optional behavior overrides (policy, normalizers, validators, logger).
   */
  apply<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    rulesResult: RulesResult<z.infer<S>>,
    llmResult: LlmResult | null,
    content: string,
    options?: MergeApplyOptions<z.infer<S>>,
  ): ExtractionResult<z.infer<S>> {
    type Data = z.infer<S>;
    const schemaKeys = Object.keys(schema.shape) as (keyof Data)[];

    const fusion = fuseAllFields<Data>(
      schemaKeys,
      rulesResult,
      llmResult,
      options?.policy,
      options?.logger,
    );

    const normalized = runNormalizers(fusion.data, options?.normalizers, content);

    const violations = collectViolations<Data>(
      schema,
      normalized,
      fusion.missing,
      options?.validators,
    );
    const valid = !violations.some((v) => v.severity === 'error');

    return {
      data: normalized,
      confidence: fusion.confidence,
      conflicts: fusion.conflicts,
      missing: fusion.missing,
      validation: { valid, violations },
      meta: {
        rulesMatched: fusion.rulesMatched,
        llmCalled: llmResult !== null,
        durationMs: 0,
      },
    };
  },
};
