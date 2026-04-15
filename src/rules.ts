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
   * {@link RuleMatch} or `null` when the rule does not apply.
   *
   * @param field - Name of the schema field the rule writes to.
   * @param extract - Callback that inspects the content and proposes a value.
   * @returns An {@link ExtractionRule} ready to be passed to {@link rule.apply}.
   */
  create(
    field: string,
    extract: (content: string) => RuleMatch<unknown> | null,
  ): ExtractionRule {
    return { field, extract };
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
  ): ExtractionRule {
    return {
      field,
      extract: (content) => {
        const match = content.match(pattern);
        if (!match) {
          return null;
        }
        const value = transform ? transform(match) : (match[1] ?? match[0]);
        return { value, confidence: confidenceScore };
      },
    };
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
   * @typeParam S - A Zod object schema.
   * @param content - Raw content to extract from (typically markdown or text).
   * @param rules - Deterministic rules to evaluate.
   * @param schema - Zod object schema describing the target data shape.
   * @param logger - Optional logger notified when a value is rejected.
   * @returns The deterministic extraction result (values, confidence, missing).
   */
  apply<S extends z.ZodObject<z.ZodRawShape>>(
    content: string,
    rules: ExtractionRule[],
    schema: S,
    logger?: Logger,
  ): RulesResult<z.infer<S>> {
    type Data = z.infer<S>;
    const schemaKeys = Object.keys(schema.shape) as (keyof Data)[];
    const values: Partial<Data> = {};
    const confidenceMap: Partial<Record<keyof Data, number>> = {};

    for (const candidate of rules) {
      const field = candidate.field as keyof Data;
      if (!schemaKeys.includes(field)) {
        continue;
      }
      const match = candidate.extract(content);
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
    }

    const missing = schemaKeys.filter((key) => !(key in values));

    return { values, confidence: confidenceMap, missing };
  },
};
