import type { z } from 'zod';
import type { Logger } from './types/logger.types.js';
import type { ExtractionRule, RuleMatch, RulesResult } from './types/rule.types.js';

/**
 * Namespace bundling every primitive used to declare and run deterministic
 * extraction rules.
 */
export const rule = {
  /**
   * Declare a deterministic extraction rule targeting a single schema field.
   *
   * The `extract` callback receives the raw content and must return either a
   * {@link RuleMatch} or `null` when the rule does not apply. It may also
   * accept an optional caller-defined `context` forwarded verbatim by
   * {@link rule.apply} / {@link Extractor.extract}.
   *
   * @typeParam TContext - Shape of the optional context forwarded to
   *   `extract`. Defaults to `unknown`.
   * @param field - Name of the schema field the rule writes to.
   * @param extract - Callback that inspects the content (and optional context)
   *   and proposes a value.
   * @param options - Optional rule metadata. `id` is surfaced in
   *   `ExtractionResult.sources` when this rule produces the kept value;
   *   defaults to `${field}#${declarationIndex}`.
   * @returns An {@link ExtractionRule} ready to be passed to {@link rule.apply}.
   */
  create<TContext = unknown>(
    field: string,
    extract: (content: string, context?: TContext) => RuleMatch<unknown> | null,
    options?: { id?: string },
  ): ExtractionRule<TContext> {
    return options?.id !== undefined ? { id: options.id, field, extract } : { field, extract };
  },

  /**
   * Shortcut to build a regex-based {@link ExtractionRule}. On match, the
   * value is taken from capture group 1 (or the full match if none), then
   * optionally passed through a `transform` callback.
   *
   * @typeParam T - Type produced by `transform`, defaults to `string`.
   * @param field - Name of the schema field the rule writes to.
   * @param pattern - Regular expression to evaluate against the content.
   * @param confidenceScore - Confidence score assigned on a successful match.
   * @param transform - Optional mapper from the raw `RegExpMatchArray` to a value.
   * @returns An {@link ExtractionRule} ready to be passed to {@link rule.apply}.
   */
  regex<T = string>(
    field: string,
    pattern: RegExp,
    confidenceScore: number,
    transform?: (match: RegExpMatchArray) => T,
    options?: { id?: string },
  ): ExtractionRule {
    const extract = (content: string): RuleMatch<unknown> | null => {
      const match = content.match(pattern);
      if (!match) {
        return null;
      }
      const value = transform ? transform(match) : (match[1] ?? match[0]);
      return { value, confidence: confidenceScore };
    };
    return options?.id !== undefined ? { id: options.id, field, extract } : { field, extract };
  },

  /**
   * Build a {@link RuleMatch} from a value and a confidence score. Syntactic
   * sugar used inside custom rule callbacks to avoid writing the object literal
   * by hand.
   *
   * @typeParam T - Type of the extracted value.
   * @param value - The extracted value.
   * @param score - Confidence score in `[0, 1]`.
   * @returns A {@link RuleMatch} wrapping `value` and `score`.
   *
   * @example
   * ```ts
   * const ageRule = rule.create('age', (text) => {
   *   const match = text.match(/(\d+)\s*years/);
   *   return match ? rule.confidence(Number(match[1]), 0.9) : null;
   * });
   * ```
   */
  confidence<T>(value: T, score: number): RuleMatch<T> {
    return { value, confidence: score };
  },

  /**
   * Run every deterministic rule against `content`, collect their matches,
   * resolve collisions by confidence, and type-check each candidate against
   * the Zod schema before accepting it.
   *
   * Behavior:
   * - Rules targeting a field absent from the schema are silently skipped.
   * - On field collisions, the highest-confidence match wins; ties favor the
   *   first-declared rule.
   * - Values failing the per-field Zod `safeParse` are discarded and the
   *   field falls back to `missing`. An optional logger receives a warning.
   *
   * The optional `context` is forwarded verbatim to every rule's `extract`
   * callback. Rules that declare a narrower `ExtractionRule<TContext>` than
   * the one passed here still compile thanks to contextual parameter
   * contravariance; rules that ignore `context` keep working unchanged.
   *
   * @typeParam S - A Zod object schema.
   * @typeParam TContext - Shape of the optional context forwarded to rules.
   * @param content - Raw content to extract from (typically markdown or text).
   * @param rules - Deterministic rules to evaluate.
   * @param schema - Zod object schema describing the target data shape.
   * @param logger - Optional logger notified when a value is rejected.
   * @param context - Optional caller-defined value forwarded to every rule's
   *   `extract` callback. Left `undefined` when omitted.
   * @returns The deterministic extraction result (values, confidence, missing).
   */
  apply<S extends z.ZodObject<z.ZodRawShape>, TContext = unknown>(
    content: string,
    rules: ExtractionRule<TContext>[],
    schema: S,
    logger?: Logger,
    context?: TContext,
  ): RulesResult<z.infer<S>> {
    type Data = z.infer<S>;
    const schemaKeys = Object.keys(schema.shape) as (keyof Data)[];
    const values: Partial<Data> = {};
    const confidenceMap: Partial<Record<keyof Data, number>> = {};
    const sourceIds: Partial<Record<keyof Data, string>> = {};

    for (let index = 0; index < rules.length; index += 1) {
      const candidate = rules[index]!;
      const field = candidate.field as keyof Data;
      if (!schemaKeys.includes(field)) {
        continue;
      }
      const match = candidate.extract(content, context);
      if (match === null) {
        continue;
      }
      const fieldSchema = schema.shape[candidate.field] as z.ZodTypeAny;
      const parsed = fieldSchema.safeParse(match.value);
      if (!parsed.success) {
        logger?.warn('rule value rejected by schema', {
          field: candidate.field,
          value: match.value,
          error: parsed.error.issues,
        });
        continue;
      }
      const existingConfidence = confidenceMap[field];
      if (existingConfidence !== undefined && match.confidence <= existingConfidence) {
        continue;
      }
      values[field] = parsed.data as Data[keyof Data];
      confidenceMap[field] = match.confidence;
      sourceIds[field] = candidate.id ?? `${candidate.field}#${index}`;
    }

    const missing = schemaKeys.filter((key) => !(key in values));

    return { values, confidence: confidenceMap, sourceIds, missing };
  },
};
