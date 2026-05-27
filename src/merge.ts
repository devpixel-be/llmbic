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
import type {
  Candidate,
  ReconcileConflict,
  ReconcilePolicy,
  ReconcileResult,
  ReconcileSource,
  ReconcileSourceKind,
  ReconcileStrategy,
} from './types/reconcile.types.js';
import { valueEquals } from './utils/value-equals.js';
import { resolveNormalizerId } from './utils/normalizer-id.js';

/**
 * Default equality: case-insensitive for strings, strict otherwise. Shared by
 * {@link merge.defaultFieldPolicy} and {@link merge.defaultReconcilePolicy} so
 * the binary and N-ary merges agree on what "the same value" means.
 */
const defaultCompare = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
};

/** A candidate enriched with its effective priority and original position. */
type RankedCandidate<T> = {
  candidate: Candidate<T>;
  /** Position in the input array; lower means earlier. */
  index: number;
  /** Effective priority: explicit `priority`, else `length - index` (earlier ranks higher). */
  priority: number;
};

/** Order by priority desc, then confidence desc, then original position asc. */
function byAuthority<T>(a: RankedCandidate<T>, b: RankedCandidate<T>): number {
  return (
    b.priority - a.priority ||
    b.candidate.confidence - a.candidate.confidence ||
    a.index - b.index
  );
}

/**
 * Pick the winning candidate per strategy. Returns `null` only for `'cascade'`
 * when no tier clears the threshold. `present` is non-empty and in input order.
 */
function selectWinner<T>(
  present: RankedCandidate<T>[],
  policy: ReconcilePolicy,
): RankedCandidate<T> | null {
  switch (policy.strategy) {
    case 'highest-confidence':
      return [...present].sort(
        (a, b) =>
          b.candidate.confidence - a.candidate.confidence ||
          b.priority - a.priority ||
          a.index - b.index,
      )[0]!;
    case 'cascade':
      return present.find((e) => e.candidate.confidence >= policy.confidentThreshold) ?? null;
    case 'prefer-when-confident': {
      const ranked = [...present].sort(byAuthority);
      return (
        ranked.find((e) => e.candidate.confidence >= policy.confidentThreshold) ??
        ranked[ranked.length - 1]!
      );
    }
    case 'highest-priority':
    case 'flag-on-conflict':
    default:
      return [...present].sort(byAuthority)[0]!;
  }
}

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
    compare: defaultCompare,
    /** See {@link FieldMergePolicy.ruleConfidenceThreshold}. */
    ruleConfidenceThreshold: 1,
  } satisfies FieldMergePolicy,

  /**
   * Library defaults applied by {@link merge.reconcile} when the caller omits
   * one or more policy fields. Mirrors {@link merge.defaultFieldPolicy}: the
   * default `'flag-on-conflict'` strategy keeps the most authoritative
   * candidate while surfacing disagreements, and agreement boosts confidence
   * to `1`.
   *
   * See {@link ReconcilePolicy} for the meaning of each field.
   */
  defaultReconcilePolicy: {
    strategy: 'flag-on-conflict',
    compare: defaultCompare,
    agreementConfidence: 1.0,
    conflictConfidence: 0.3,
    confidentThreshold: 1,
  } satisfies ReconcilePolicy,

  /**
   * Reconcile N candidate values for a single field into one kept value, its
   * confidence, and its provenance. The N-ary generalization of
   * {@link merge.field}: instead of a fixed (rule, llm) pair, any number of
   * sources - rules, an LLM, external services, human overrides - compete
   * under a {@link ReconcilePolicy}.
   *
   * Agreement is cardinal: two or more candidates sharing the kept value (per
   * `compare`) raise the confidence to `agreementConfidence`, whatever the
   * strategy. Every dissenting candidate is reported in `conflicts` for
   * observability; `source.kind` records whether the value stands alone, on an
   * agreement, despite a conflict, or after a cascade fall-through.
   *
   * Any policy field omitted from `policy` falls back to
   * {@link merge.defaultReconcilePolicy}.
   *
   * @typeParam T - Type of the candidate values.
   * @param field - Name of the field being reconciled (echoed into conflicts).
   * @param candidates - One entry per source; `null`/`undefined` values are absent.
   * @param policy - Optional strategy and confidence overrides.
   */
  reconcile<T>(
    field: string,
    candidates: Candidate<T>[],
    policy?: Partial<ReconcilePolicy>,
  ): ReconcileResult<T> {
    const fullPolicy: ReconcilePolicy = { ...merge.defaultReconcilePolicy, ...policy };
    const total = candidates.length;
    const present = candidates
      .map((candidate, index) => ({
        candidate,
        index,
        priority: candidate.priority ?? total - index,
      }))
      .filter((e) => e.candidate.value !== null && e.candidate.value !== undefined);

    if (present.length === 0) {
      return { value: null, confidence: null, source: null, conflicts: [] };
    }

    const winner = selectWinner(present, fullPolicy);
    if (winner === null) {
      return { value: null, confidence: null, source: null, conflicts: [] };
    }

    const agreed = present.filter((e) =>
      fullPolicy.compare(e.candidate.value, winner.candidate.value),
    );
    const dissenters = present.filter(
      (e) => !fullPolicy.compare(e.candidate.value, winner.candidate.value),
    );

    let kind: ReconcileSourceKind;
    let confidence: number;
    if (agreed.length >= 2) {
      kind = 'agreement';
      confidence = fullPolicy.agreementConfidence;
    } else if (fullPolicy.strategy === 'flag-on-conflict' && dissenters.length > 0) {
      kind = 'conflict';
      confidence = fullPolicy.conflictConfidence;
    } else if (fullPolicy.strategy === 'cascade' && winner.index !== present[0]!.index) {
      kind = 'cascade';
      confidence = winner.candidate.confidence;
    } else {
      kind = 'single';
      confidence = winner.candidate.confidence;
    }

    const conflicts: ReconcileConflict[] = dissenters.map((d) => ({
      field,
      winner: {
        source: winner.candidate.source,
        value: winner.candidate.value,
        confidence: winner.candidate.confidence,
      },
      dissenter: {
        source: d.candidate.source,
        value: d.candidate.value,
        confidence: d.candidate.confidence,
      },
    }));

    const source: ReconcileSource = {
      kind,
      winner: winner.candidate.source,
      agreedBy: agreed.map((e) => e.candidate.source),
      dissentedBy: dissenters.map((e) => e.candidate.source),
    };

    return { value: winner.candidate.value as T, confidence, source, conflicts };
  },

  /**
   * Fuse a rule match and an LLM value for a single field, following the
   * provided policy. Returns the kept value, its confidence, and a conflict
   * record if the strategy flagged a disagreement.
   *
   * Any policy field omitted from `policy` falls back to
   * {@link merge.defaultFieldPolicy}.
   *
   * Thin binary adapter over {@link merge.reconcile}: the rule and the LLM
   * become two candidates, the conflict strategy maps to a reconcile strategy
   * plus a priority order, and the result is projected back onto the binary
   * contract (rule value kept on agreement, conflict recorded only on flag).
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

    // Map the binary (rule, llm) policy onto the N-ary reconcile engine: the
    // two roles become two candidates, and the conflict strategy becomes a
    // reconcile strategy plus a priority order (which side outranks the other).
    let strategy: ReconcileStrategy;
    let ruleOutranksLlm = true;
    switch (fullPolicy.strategy) {
      case 'prefer-rule':
        strategy = 'highest-priority';
        break;
      case 'prefer-llm':
        strategy = 'highest-priority';
        ruleOutranksLlm = false;
        break;
      case 'prefer-rule-when-confident':
        strategy = 'prefer-when-confident';
        break;
      case 'flag':
        strategy = 'flag-on-conflict';
        break;
      default:
        logger?.warn('unknown conflict strategy, falling back to flag', {
          strategy: fullPolicy.strategy,
          field,
        });
        strategy = 'flag-on-conflict';
    }

    const ruleCandidate: Candidate<T> | null =
      ruleMatch !== null
        ? { value: ruleMatch.value, confidence: ruleMatch.confidence, source: 'rule' }
        : null;
    const llmCandidate: Candidate<T> | null =
      normalizedLlm !== null
        ? { value: normalizedLlm as T, confidence: fullPolicy.defaultLlmConfidence, source: 'llm' }
        : null;

    // Array order sets the default priority (earlier ranks higher), so the
    // outranking side goes first.
    const ordered = ruleOutranksLlm
      ? [ruleCandidate, llmCandidate]
      : [llmCandidate, ruleCandidate];
    const candidates = ordered.filter((c): c is Candidate<T> => c !== null);

    const result = merge.reconcile<T>(field, candidates, {
      strategy,
      compare: fullPolicy.compare,
      agreementConfidence: fullPolicy.agreementConfidence,
      conflictConfidence: fullPolicy.flaggedConfidence,
      confidentThreshold: fullPolicy.ruleConfidenceThreshold,
    });

    // Preserve the binary contract: on agreement the rule value is the kept
    // representation (the reconcile winner may be the LLM candidate but carries
    // the same value per `compare`), and a conflict record is produced only
    // when a disagreement was flagged.
    const value =
      result.source?.kind === 'agreement' && ruleMatch !== null ? ruleMatch.value : result.value;
    const conflict: Conflict | undefined =
      result.source?.kind === 'conflict' && ruleMatch !== null
        ? {
            field,
            ruleValue: ruleMatch.value,
            ruleConfidence: ruleMatch.confidence,
            llmValue: normalizedLlm,
          }
        : undefined;

    return { value, confidence: result.confidence, conflict };
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
