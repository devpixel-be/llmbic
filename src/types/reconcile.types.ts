import type { FieldCompare } from './merge.types.js';

/**
 * One proposed value for a field, coming from a single source, with the
 * confidence that source has in it. The N-ary generalization of the
 * (rule, llm) pair consumed by {@link merge.field}: any number of sources -
 * deterministic rules, an LLM, external services, manual overrides - can be
 * reconciled through {@link merge.reconcile}.
 *
 * @typeParam T - Type of the proposed value.
 */
export type Candidate<T> = {
  /** The proposed value, or `null`/`undefined` when this source had nothing. */
  value: T | null | undefined;
  /** Confidence this source has in `value`, in `[0, 1]`. */
  confidence: number;
  /**
   * Stable source identifier surfaced in {@link ReconcileSource}
   * (e.g. `'rule:price'`, `'llm'`, `'service'`).
   */
  source: string;
  /**
   * Authority of the source: a higher number wins ties and conflicts. When
   * omitted, the candidate's position in the array decides - earlier entries
   * rank higher - so `[authoritative, fallback]` works without explicit
   * priorities.
   */
  priority?: number;
};

/**
 * How {@link merge.reconcile} picks the kept value among the present
 * candidates. Agreement detection and conflict reporting run on top of every
 * strategy; the strategy only decides which single candidate wins.
 *
 * - `'highest-priority'` - keep the highest-priority candidate. The legacy
 *   `'prefer-rule'`/`'prefer-llm'` strategies are this strategy with the
 *   winning source ranked first.
 * - `'highest-confidence'` - keep the most-confident candidate, priority
 *   breaking ties.
 * - `'cascade'` - walk candidates in array order and keep the first whose
 *   confidence is at or above {@link ReconcilePolicy.confidentThreshold};
 *   an ordered list of fallback sources. Yields `null` when none clear the bar.
 * - `'flag-on-conflict'` - keep the highest-priority candidate but, when any
 *   present candidate disagrees, lower the confidence to
 *   {@link ReconcilePolicy.conflictConfidence} and mark the source
 *   `'conflict'`. The N-ary form of the legacy `'flag'` strategy.
 * - `'prefer-when-confident'` - walk candidates by priority and keep the first
 *   whose confidence is at or above the threshold; if none qualify, the
 *   lowest-priority candidate is the final fallback. The N-ary form of
 *   `'prefer-rule-when-confident'`.
 */
export type ReconcileStrategy =
  | 'highest-priority'
  | 'highest-confidence'
  | 'cascade'
  | 'flag-on-conflict'
  | 'prefer-when-confident';

/**
 * Behaviour overrides for {@link merge.reconcile}. Every field is optional and
 * falls back to {@link merge.defaultReconcilePolicy}.
 */
export type ReconcilePolicy = {
  /** How to pick the kept value among present candidates. */
  strategy: ReconcileStrategy;
  /** Equality (or tolerance) check used to detect agreement between candidates. */
  compare: FieldCompare;
  /** Confidence assigned when two or more candidates agree on the kept value. */
  agreementConfidence: number;
  /**
   * Confidence assigned when `'flag-on-conflict'` keeps a value despite a
   * disagreement.
   */
  conflictConfidence: number;
  /**
   * Threshold consulted by `'cascade'` (minimum acceptable confidence) and by
   * `'prefer-when-confident'`. Default `1`.
   */
  confidentThreshold: number;
};

/**
 * Why {@link merge.reconcile} kept the value it kept.
 *
 * - `'single'` - one candidate carried the day with no peer agreeing.
 * - `'agreement'` - two or more candidates agreed on the kept value.
 * - `'conflict'` - the value was kept despite a disagreement (`'flag-on-conflict'`).
 * - `'cascade'` - a later tier won after earlier tiers fell through.
 */
export type ReconcileSourceKind = 'single' | 'agreement' | 'conflict' | 'cascade';

/**
 * Provenance of a reconciled value: the winning source, the sources that
 * agreed with it (including the winner), and the sources that dissented.
 */
export type ReconcileSource = {
  kind: ReconcileSourceKind;
  /** Source id of the winning candidate. */
  winner: string;
  /** Source ids whose value agreed with the winner (winner included). */
  agreedBy: string[];
  /** Source ids whose value disagreed with the winner. */
  dissentedBy: string[];
};

/**
 * A disagreement between the kept value and one dissenting candidate, surfaced
 * by {@link merge.reconcile} for observability regardless of the strategy.
 */
export type ReconcileConflict = {
  /** Name of the field being reconciled. */
  field: string;
  /** The candidate that won. */
  winner: { source: string; value: unknown; confidence: number };
  /** A candidate whose value disagreed with the winner. */
  dissenter: { source: string; value: unknown; confidence: number };
};

/**
 * Outcome of reconciling N candidates for a single field.
 *
 * @typeParam T - Type of the reconciled value.
 */
export type ReconcileResult<T> = {
  /** The value kept, or `null` if no candidate provided one. */
  value: T | null;
  /** Confidence associated with `value`, in `[0, 1]`, or `null` if absent. */
  confidence: number | null;
  /** Provenance of the kept value, or `null` when no candidate had a value. */
  source: ReconcileSource | null;
  /** One entry per dissenting candidate; empty when all present candidates agree. */
  conflicts: ReconcileConflict[];
};
