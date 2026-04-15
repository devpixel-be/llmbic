import type { LlmRequest } from './prompt.types.js';

/**
 * Transport contract between llmbic and an LLM backend. Provider adapters
 * (OpenAI, Anthropic, custom) implement this single method; the rest of the
 * library never touches SDK-specific types.
 */
export type LlmProvider = {
  /**
   * Send `request` to the underlying model and return the structured values
   * it produced. Observability concerns (token counters, latency, cost) are
   * the caller's responsibility — they live outside the llmbic contract so
   * the library stays free of vendor-specific metering.
   *
   * @param request - Prompt, user content, and JSON Schema built by {@link prompt.build}.
   * @returns Raw values keyed by field name, parsed by {@link prompt.parse} before reaching the merge step.
   */
  complete(request: LlmRequest): Promise<{ values: Record<string, unknown> }>;
};
