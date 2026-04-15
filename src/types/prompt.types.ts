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
