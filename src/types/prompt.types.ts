/**
 * Selects whether the LLM is asked only about fields the deterministic pass
 * could not produce (`'fill-gaps'`, default) or about every schema field
 * (`'cross-check'`, enabling agreement/conflict detection with the rules).
 */
export type PromptBuildMode = 'fill-gaps' | 'cross-check';

/**
 * Whether a cross-check request exposes the rule values to the LLM as hints.
 *
 * - `'unbiased'` (default): no hints, the LLM re-extracts every field from
 *   scratch, enabling genuine disagreement detection.
 * - `'bias'`: prepend the rule values as an "Already extracted" block, same
 *   shape as fill-gaps. Saves tokens when the caller trusts the rules and
 *   only wants a quick sanity check.
 *
 * Ignored when `mode !== 'cross-check'`.
 */
export type CrossCheckHints = 'bias' | 'unbiased';

/**
 * Optional behavior overrides for `prompt.build`.
 */
export type PromptBuildOptions = {
  /** Custom system prompt sent to the provider; falls back to a built-in. */
  systemPrompt?: string;
  /** Field-selection strategy. Defaults to `'fill-gaps'`. */
  mode?: PromptBuildMode;
  /** Hint-exposure policy in cross-check mode. Defaults to `'unbiased'`. */
  crossCheckHints?: CrossCheckHints;
};

/**
 * A fully-built request ready to be handed to an LLM provider. Produced by
 * {@link prompt.build} from a schema and a partial extraction result.
 */
export type LlmRequest = {
  /** Instruction prefix sent as the system/role message. */
  systemPrompt: string;
  /** User-facing payload: the original content augmented with known values. */
  userContent: string;
  /**
   * JSON Schema restricted to the fields the deterministic pass could not
   * resolve. Consumers pass it to a provider's structured-output feature.
   */
  responseSchema: object;
  /**
   * Values the deterministic pass already produced, mirrored here so
   * providers that accept metadata (tool arguments, function signatures, ...)
   * can surface them without re-parsing `userContent`.
   */
  knownValues: Record<string, unknown>;
};
