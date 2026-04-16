import type { z } from 'zod';
import type { ExtractionRule } from './rule.types.js';
import type {
  ExtractedData,
  ExtractionResult,
  FieldMergePolicy,
  LlmResult,
  Normalizer,
} from './merge.types.js';
import type { LlmProvider } from './provider.types.js';
import type { Logger } from './logger.types.js';
import type { Validator } from './validate.types.js';
import type { CrossCheckHints, LlmRequest, PromptBuildMode } from './prompt.types.js';

/**
 * LLM-fallback section of {@link ExtractorConfig}. When present, the
 * extractor hands the fields the deterministic rules could not produce to
 * the configured {@link LlmProvider}.
 */
export type ExtractorLlmConfig = {
  /** Provider adapter the extractor calls for missing fields. */
  provider: LlmProvider;
  /** Optional override for {@link LlmRequest.systemPrompt}; defaults to the {@link prompt.build} built-in. */
  systemPrompt?: string;
  /**
   * Field-selection strategy passed to {@link prompt.build}. In
   * `'cross-check'` mode the extractor always calls the LLM (even when the
   * rules resolved every field) so the merge step can surface agreements or
   * conflicts. Defaults to `'fill-gaps'`.
   */
  mode?: PromptBuildMode;
  /**
   * Hint-exposure policy for cross-check mode. Defaults to `'unbiased'`.
   * Ignored when `mode !== 'cross-check'`.
   */
  crossCheckHints?: CrossCheckHints;
  /**
   * Hook called with the fully-built {@link LlmRequest} just before
   * `provider.complete`. Return the request to send. Useful for PII
   * redaction (replace emails / phones / IDs in `userContent`), locale
   * tagging (prepend `Language: ...` to `systemPrompt`), or any caller-side
   * pre-processing. The original `content` is forwarded so the hook can
   * cross-reference it. May be asynchronous; errors propagate to `extract`.
   */
  transformRequest?: (
    request: LlmRequest,
    content: string,
  ) => LlmRequest | Promise<LlmRequest>;
  /**
   * Hook called with the parsed {@link LlmResult} just after
   * `provider.complete`. Return the result the merge step should use. Useful
   * for restoring PII-redacted values, applying caller-side post-processing,
   * or stripping unsafe content. Receives the (possibly transformed) request
   * for context. May be asynchronous; errors propagate to `extract`.
   */
  transformResponse?: (
    result: LlmResult,
    request: LlmRequest,
  ) => LlmResult | Promise<LlmResult>;
};

/**
 * Configuration accepted by {@link createExtractor}. A schema describes the
 * target shape and a list of deterministic {@link ExtractionRule}s tries to
 * produce values for each field before any LLM fallback kicks in.
 *
 * @typeParam S - A Zod object schema describing the target data shape.
 */
export type ExtractorConfig<S extends z.ZodObject<z.ZodRawShape>> = {
  /** Zod object schema the extractor targets. Drives field enumeration and re-validation. */
  schema: S;
  /** Deterministic rules evaluated against the raw content before any LLM fallback. */
  rules: ExtractionRule[];
  /** Optional LLM fallback invoked for fields the rules could not produce. */
  llm?: ExtractorLlmConfig;
  /** Post-merge transformations, forwarded to every `merge.apply` call. */
  normalizers?: Normalizer<z.infer<S>>[];
  /** Invariants checked on the normalized data; populate `result.validation`. */
  validators?: Validator<ExtractedData<z.infer<S>>>[];
  /** Overrides for the per-field merge policy (conflict strategy, confidences, compare). */
  policy?: Partial<FieldMergePolicy>;
  /**
   * Per-field policy overrides applied on top of `policy`. Precedence:
   * library defaults < `policy` < `policyByField[field]`. Forwarded to every
   * internal `merge.apply` call.
   */
  policyByField?: { [K in keyof z.infer<S>]?: Partial<FieldMergePolicy> };
  /** Logger propagated through the merge pipeline for warnings and fallbacks. */
  logger?: Logger;
};

/**
 * Public surface returned by {@link createExtractor}. Methods are added to
 * this interface as the matching slice introduces them.
 *
 * @typeParam T - Shape of the target data object inferred from a Zod schema.
 */
export type Extractor<T> = {
  /**
   * Run the full extraction pipeline against `content`: deterministic rules,
   * optionally followed by an LLM fallback for missing fields, then the merge
   * + validation step.
   */
  extract(content: string): Promise<ExtractionResult<T>>;
  /**
   * Run the deterministic rules and merge them against a `null` LLM result.
   * Synchronous counterpart to {@link Extractor.extract} for batch workflows
   * where the LLM call is managed by the caller (queues, scheduled jobs,
   * external batch APIs).
   */
  extractSync(content: string): ExtractionResult<T>;
  /**
   * Build the LLM request for `partial`. The target field set depends on the
   * configured `llm.mode`: `'fill-gaps'` (default) covers only
   * `partial.missing`; `'cross-check'` covers every schema field. Delegates
   * to {@link prompt.build} with the bound schema and the configured
   * `systemPrompt` / `crossCheckHints`.
   */
  prompt(content: string, partial: ExtractionResult<T>): LlmRequest;
  /**
   * Parse a raw LLM response permissively, validating each schema field that
   * appears in the payload. Fields outside the schema are dropped with a
   * warning. Delegates to {@link prompt.parse} with every schema key as the
   * accepted set.
   */
  parse(raw: unknown): LlmResult;
  /**
   * Merge a previously-obtained `partial` with an LLM result and re-run the
   * deterministic rules to produce the final {@link ExtractionResult}.
   * Rules are pure, so re-running them is cheaper than carrying private
   * state on the extractor.
   */
  merge(
    partial: ExtractionResult<T>,
    llmResult: LlmResult,
    content: string,
  ): ExtractionResult<T>;
};
