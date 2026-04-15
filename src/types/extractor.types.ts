import type { z } from 'zod';
import type { ExtractionRule } from './rule.types.js';
import type { ExtractionResult, LlmResult } from './merge.types.js';
import type { LlmProvider } from './provider.types.js';
import type { LlmRequest } from './prompt.types.js';

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
   * Build the LLM request for the fields still missing in `partial`.
   * Delegates to {@link prompt.build} with the bound schema.
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
