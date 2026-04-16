import type { z } from 'zod';
import { rule } from './rules.js';
import { merge } from './merge.js';
import { prompt } from './prompt.js';
import type { Extractor, ExtractorConfig } from './types/extractor.types.js';
import type { ExtractionResult, MergeApplyOptions } from './types/merge.types.js';
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
 * Bind a schema, deterministic rules and their merge-time options into an
 * {@link Extractor}. The returned object exposes the extraction pipeline as
 * pre-configured methods; call sites stop having to thread `schema`,
 * `rules`, `policy`, normalizers/validators and provider wiring through
 * every step.
 *
 * {@link Extractor.extract} runs {@link rule.apply}, then - when an LLM is
 * configured - asks the provider either for the missing fields only
 * (`mode: 'fill-gaps'`, default) or for every schema field
 * (`mode: 'cross-check'`, which always triggers the LLM call so conflicts
 * can be detected even when the rules resolved every field). The response
 * is parsed with {@link prompt.parse} and fused through {@link merge.apply}.
 *
 * @typeParam S - A Zod object schema describing the target data shape.
 * @param config - Schema, deterministic rules, and optional LLM fallback,
 *   plus `policy`, `normalizers`, `validators` and `logger` forwarded to
 *   every internal {@link merge.apply} call. The logger is also forwarded
 *   to {@link rule.apply} so schema-rejection warnings stay visible.
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

  const buildOptions = {
    systemPrompt: config.llm?.systemPrompt,
    mode: config.llm?.mode ?? 'fill-gaps',
    crossCheckHints: config.llm?.crossCheckHints ?? 'unbiased',
  } as const;

  const mergeOptions: MergeApplyOptions<Data> = {
    policy: config.policy,
    normalizers: config.normalizers,
    validators: config.validators,
    logger: config.logger,
  };

  return {
    async extract(content) {
      const startedAt = performance.now();
      const rulesResult = rule.apply(content, config.rules, config.schema, config.logger);
      const partial = merge.apply(config.schema, rulesResult, null, content, mergeOptions);

      const shouldCallLlm =
        config.llm !== undefined &&
        (buildOptions.mode === 'cross-check' || partial.missing.length > 0);
      if (!shouldCallLlm) {
        return stampDuration(partial, startedAt);
      }

      const request = prompt.build(config.schema, partial, content, buildOptions);
      const completion = await config.llm!.provider.complete(request);
      const llmTargetFields =
        buildOptions.mode === 'cross-check' ? allFields : partial.missing;
      const llmResult = prompt.parse(
        config.schema,
        llmTargetFields,
        completion.values,
      );
      const final = merge.apply(config.schema, rulesResult, llmResult, content, mergeOptions);
      return stampDuration(final, startedAt);
    },

    extractSync(content) {
      const startedAt = performance.now();
      const rulesResult = rule.apply(content, config.rules, config.schema, config.logger);
      const partial = merge.apply(config.schema, rulesResult, null, content, mergeOptions);
      return stampDuration(partial, startedAt);
    },

    prompt(content, partial) {
      return prompt.build(config.schema, partial, content, buildOptions);
    },

    parse(raw) {
      return prompt.parse(config.schema, allFields, raw);
    },

    merge(partial, llmResult, content) {
      const startedAt = performance.now();
      const rulesResult = rulesResultFromPartial(partial, allFields);
      const result = merge.apply(config.schema, rulesResult, llmResult, content, mergeOptions);
      return stampDuration(result, startedAt);
    },
  };
}
