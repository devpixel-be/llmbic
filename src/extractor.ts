import type { z } from 'zod';
import { rule } from './rules.js';
import { merge } from './merge.js';
import { prompt } from './prompt.js';
import type { Extractor, ExtractorConfig } from './types/extractor.types.js';
import type { ExtractionResult } from './types/merge.types.js';
import type { RulesResult } from './types/rule.types.js';

/**
 * Reconstruct a {@link RulesResult} from a `partial` that was previously
 * produced by `extractSync` (i.e. a rules-only merge). Avoids re-running the
 * rules during a deferred {@link Extractor.merge} call, since the partial
 * already carries every rule value and its confidence.
 */
function rulesResultFromPartial<T>(
  partial: ExtractionResult<T>,
  allFields: readonly (keyof T)[],
): RulesResult<T> {
  const values: Partial<T> = {};
  const confidence: Partial<Record<keyof T, number>> = {};
  for (const field of allFields) {
    const value = partial.data[field];
    if (value === null) {
      continue;
    }
    values[field] = value as T[keyof T];
    const fieldConfidence = partial.confidence[field];
    if (fieldConfidence !== null) {
      confidence[field] = fieldConfidence;
    }
  }
  return { values, confidence, missing: [...partial.missing] };
}

/**
 * Stamp `result.meta.durationMs` with the wall-clock elapsed since `startedAt`.
 * Used by every {@link Extractor} method that returns an {@link ExtractionResult},
 * so consumers see real timings instead of the placeholder `0` left by
 * {@link merge.apply}.
 */
function stampDuration<T>(
  result: ExtractionResult<T>,
  startedAt: number,
): ExtractionResult<T> {
  return {
    ...result,
    meta: { ...result.meta, durationMs: performance.now() - startedAt },
  };
}

/**
 * Bind a schema, deterministic rules and an optional LLM fallback into an
 * {@link Extractor}. The returned object exposes the extraction pipeline as
 * pre-configured methods; call sites stop having to thread `schema`,
 * `rules` and provider wiring through every step.
 *
 * {@link Extractor.extract} runs {@link rule.apply}, then — when an LLM is
 * configured and some fields are still missing — asks the provider for those
 * fields only, parses the response with {@link prompt.parse} and fuses
 * everything through {@link merge.apply}.
 *
 * @typeParam S - A Zod object schema describing the target data shape.
 * @param config - Schema, deterministic rules, and optional LLM fallback.
 * @returns An {@link Extractor} bound to `config.schema`.
 */
export function createExtractor<S extends z.ZodObject<z.ZodRawShape>>(
  config: ExtractorConfig<S>,
): Extractor<z.infer<S>> {
  type Data = z.infer<S>;
  const allFields = Object.keys(config.schema.shape) as (keyof Data)[];

  if (allFields.length === 0) {
    throw new Error('createExtractor: schema must declare at least one field');
  }

  return {
    async extract(content) {
      const startedAt = performance.now();
      const rulesResult = rule.apply(content, config.rules, config.schema);
      const partial = merge.apply(config.schema, rulesResult, null, content);

      if (!config.llm || partial.missing.length === 0) {
        return stampDuration(partial, startedAt);
      }

      const request = prompt.build(config.schema, partial, content, {
        systemPrompt: config.llm.systemPrompt,
      });
      const completion = await config.llm.provider.complete(request);
      const llmResult = prompt.parse(
        config.schema,
        partial.missing,
        completion.values,
      );
      const final = merge.apply(config.schema, rulesResult, llmResult, content);
      return stampDuration(final, startedAt);
    },

    extractSync(content) {
      const startedAt = performance.now();
      const rulesResult = rule.apply(content, config.rules, config.schema);
      const partial = merge.apply(config.schema, rulesResult, null, content);
      return stampDuration(partial, startedAt);
    },

    prompt(content, partial) {
      return prompt.build(config.schema, partial, content, {
        systemPrompt: config.llm?.systemPrompt,
      });
    },

    parse(raw) {
      return prompt.parse(config.schema, allFields, raw);
    },

    merge(partial, llmResult, content) {
      const startedAt = performance.now();
      const rulesResult = rulesResultFromPartial(partial, allFields);
      const result = merge.apply(config.schema, rulesResult, llmResult, content);
      return stampDuration(result, startedAt);
    },
  };
}
