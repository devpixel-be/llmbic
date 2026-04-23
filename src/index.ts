/**
 * Llmbic - public entry point.
 *
 * Re-exports the five namespaces that make up the library (`createExtractor`,
 * `rule`, `merge`, `prompt`, `validator`) and every public type consumers need
 * to describe schemas, rules, providers, normalizers and validators.
 *
 * Llmbic does not ship vendor-specific provider adapters: the {@link LlmProvider}
 * contract is a single-method interface, consumers implement it in ~10 lines
 * using whichever SDK or HTTP client they prefer (see README).
 */

export { createExtractor } from './extractor.js';
export { rule } from './rules.js';
export { merge, defineNormalizer } from './merge.js';
export { prompt } from './prompt.js';
export { validator } from './validate.js';

export type {
  ExtractionRule,
  RuleMatch,
  RulesResult,
} from './types/rule.types.js';

export type {
  Extractor,
  ExtractorConfig,
  ExtractorLlmConfig,
} from './types/extractor.types.js';

export type {
  CrossCheckHints,
  LlmRequest,
  PromptBuildMode,
  PromptBuildOptions,
} from './types/prompt.types.js';
export type { LlmProvider } from './types/provider.types.js';
export type { Logger } from './types/logger.types.js';

export type {
  Severity,
  Violation,
  Validator,
} from './types/validate.types.js';

export type {
  Conflict,
  ConflictStrategy,
  ExtractedData,
  ExtractionMeta,
  ExtractionResult,
  FieldCompare,
  FieldMergePolicy,
  FieldMergeResult,
  FieldSource,
  LlmResult,
  MergeApplyOptions,
  Normalizer,
  NormalizerMutation,
  ValidationResult,
} from './types/merge.types.js';
