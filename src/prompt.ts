import type { z } from 'zod';
import type {
  ExtractedData,
  ExtractionResult,
  LlmResult,
} from './types/merge.types.js';
import type { LlmRequest, PromptBuildOptions } from './types/prompt.types.js';

const DEFAULT_SYSTEM_PROMPT =
  'Extract the listed fields from the content as a JSON object.';

type ZodFieldDef = { type: string; [extra: string]: unknown };
type ZodLike = { def: ZodFieldDef; description?: string };

/**
 * Convert a `z.nullable(inner)` into JSON Schema by recursing into `inner`
 * and widening its `type` to `[innerType, 'null']`. Refuses nested nullables
 * whose inner already carries a tuple `type`.
 */
function nullableToJsonSchema(def: ZodFieldDef, field: string): Record<string, unknown> {
  const inner = zodFieldToJsonSchema(def.innerType as ZodLike, field);
  const innerType = inner.type;
  if (typeof innerType !== 'string') {
    throw new Error(`Unsupported nested nullable on field "${field}"`);
  }
  return { ...inner, type: [innerType, 'null'] };
}

/**
 * Convert a `z.object(shape)` into JSON Schema by recursing over every
 * property. Children wrapped in `z.optional(...)` are kept in `properties`
 * but excluded from the object-level `required` list.
 */
function objectToJsonSchema(def: ZodFieldDef, field: string): Record<string, unknown> {
  const shape = def.shape as Record<string, ZodLike>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(shape)) {
    properties[key] = zodFieldToJsonSchema(child, `${field}.${key}`);
    if (child.def.type !== 'optional') {
      required.push(key);
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Dispatch the conversion by Zod kind. Primitives short-circuit, wrappers
 * (`optional`, `default`, `nullable`, `array`, `object`) recurse, unsupported
 * kinds throw with the offending `field` named so the caller can restructure
 * their schema.
 */
function zodKindToJsonSchema(
  def: ZodFieldDef,
  kind: string,
  field: string,
): Record<string, unknown> {
  switch (kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return { type: kind };
    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string | number>) };
    case 'nullable':
      return nullableToJsonSchema(def, field);
    case 'optional':
    case 'default':
      return zodFieldToJsonSchema(def.innerType as ZodLike, field);
    case 'array':
      return { type: 'array', items: zodFieldToJsonSchema(def.element as ZodLike, field) };
    case 'object':
      return objectToJsonSchema(def, field);
    default:
      throw new Error(`Unsupported Zod type "${kind}" on field "${field}"`);
  }
}

/**
 * Convert a single Zod field schema to JSON Schema. Wraps the kind-level
 * dispatch with a `description` pass so `.describe()` / `.meta({ description })`
 * registered at this recursion level flows through to the output; providers'
 * structured-output features consume it natively.
 */
function zodFieldToJsonSchema(zodType: ZodLike, field: string): Record<string, unknown> {
  const schema = zodKindToJsonSchema(zodType.def, zodType.def.type, field);
  const description = zodType.description;
  return description ? { ...schema, description } : schema;
}

/**
 * Build the JSON Schema handed to the LLM, restricted to the fields the
 * deterministic pass could not produce. Optional top-level fields are kept
 * in `properties` but excluded from `required`.
 */
function buildResponseSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  missing: readonly string[],
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const shape = schema.shape as unknown as Record<string, ZodLike>;
  for (const field of missing) {
    const zodField = shape[field];
    if (zodField === undefined) {
      continue;
    }
    properties[field] = zodFieldToJsonSchema(zodField, field);
    if (zodField.def.type !== 'optional') {
      required.push(field);
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Pick the non-null, non-missing entries of the partial result - the values
 * the deterministic pass has already resolved.
 */
function collectKnownValues<T>(
  data: ExtractedData<T>,
  missing: readonly (keyof T)[],
): Record<string, unknown> {
  const missingSet = new Set<string>(missing as readonly string[]);
  const known: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (missingSet.has(key)) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    known[key] = value;
  }
  return known;
}

/**
 * Prepend the known values as a short hint block so the LLM can ground its
 * extraction in the deterministic pass. Returns the raw content unchanged
 * when nothing is known yet.
 */
function formatUserContent(content: string, knownValues: Record<string, unknown>): string {
  const keys = Object.keys(knownValues);
  if (keys.length === 0) {
    return content;
  }
  const lines = keys.map((key) => `- ${key} = ${JSON.stringify(knownValues[key])}`);
  return `Already extracted:\n${lines.join('\n')}\n\n${content}`;
}

/**
 * Decode a raw LLM response into a plain object. Accepts either an already
 * parsed object or a JSON-encoded string. Returns a warning message instead
 * of throwing when the payload cannot be used.
 */
function decodeRaw(
  raw: unknown,
): { object: Record<string, unknown> } | { warning: string } {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return { warning: 'response is not valid JSON' };
    }
  }
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate)
  ) {
    return { warning: 'response is not valid JSON' };
  }
  return { object: candidate as Record<string, unknown> };
}

/**
 * Validate the fields the LLM was asked to produce, keeping those that match
 * their Zod schema and collecting a warning per field that fails validation.
 */
function validateMissingFields(
  schema: z.ZodObject<z.ZodRawShape>,
  missing: readonly string[],
  object: Record<string, unknown>,
): { values: Record<string, unknown>; warnings: string[] } {
  const shape = schema.shape as Record<string, z.ZodType>;
  const values: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const field of missing) {
    if (!(field in object)) {
      continue;
    }
    const fieldSchema = shape[field];
    if (fieldSchema === undefined) {
      continue;
    }
    const parsed = fieldSchema.safeParse(object[field]);
    if (parsed.success) {
      values[field] = parsed.data;
    } else {
      const reason = parsed.error.issues[0]?.message ?? 'invalid value';
      warnings.push(`field ${field}: ${reason}`);
    }
  }
  return { values, warnings };
}

/**
 * Collect the keys present in the response that were not part of `missing`.
 * These are dropped, but the caller surfaces an aggregated warning so prompt
 * engineering issues (LLM ignoring the restricted schema) stay visible.
 */
function collectUnexpectedKeys(
  object: Record<string, unknown>,
  missing: readonly string[],
): string[] {
  const missingSet = new Set(missing);
  return Object.keys(object).filter((key) => !missingSet.has(key));
}

/**
 * Prompt-building primitives that turn a partial extraction result into an
 * {@link LlmRequest} targeted at the fields the deterministic pass could not
 * produce.
 */
export const prompt = {
  /**
   * Build an LLM request targeting a subset of the schema's fields.
   *
   * - In `'fill-gaps'` mode (default) the response schema covers only
   *   `partial.missing`, and rule values flow back to the LLM as hints both
   *   through `knownValues` and a prepended "Already extracted" block in
   *   `userContent`.
   * - In `'cross-check'` mode the response schema covers every schema field,
   *   so {@link merge.apply} can surface agreements or disagreements with
   *   the rule pass. `crossCheckHints: 'unbiased'` (default) drops the hint
   *   block and empties `knownValues` so the LLM re-extracts from scratch;
   *   `'bias'` keeps the hints to save tokens at the cost of confirmation
   *   bias.
   *
   * Orchestration only: the four phases (response-schema build, known-values
   * collection, user-content formatting, request assembly) each live in their
   * own private helper above.
   *
   * @typeParam S - A Zod object schema describing the full target shape.
   * @param schema - Zod object schema that drives the field selection.
   * @param partial - Output of {@link merge.apply} (or any equivalent partial)
   *   `data` is always read; `missing` drives the fill-gaps schema and the
   *   hint block.
   * @param content - Original text the request will refer to.
   * @param options - Optional overrides: `systemPrompt`, `mode`, `crossCheckHints`.
   * @throws When a target field uses an unsupported Zod kind; the error
   *   message names the offending field.
   */
  build<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    partial: Pick<ExtractionResult<z.infer<S>>, 'data' | 'missing'>,
    content: string,
    options?: PromptBuildOptions,
  ): LlmRequest {
    type Data = z.infer<S>;
    const mode = options?.mode ?? 'fill-gaps';
    const crossCheckHints = options?.crossCheckHints ?? 'unbiased';
    const targetFields =
      mode === 'cross-check'
        ? (Object.keys(schema.shape) as readonly string[])
        : (partial.missing as readonly string[]);
    const responseSchema = buildResponseSchema(schema, targetFields);
    const exposeHints = mode === 'fill-gaps' || crossCheckHints === 'bias';
    const knownValues = exposeHints
      ? collectKnownValues<Data>(partial.data, partial.missing)
      : {};
    const userContent = formatUserContent(content, knownValues);
    return {
      systemPrompt: options?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      userContent,
      responseSchema,
      knownValues,
    };
  },

  /**
   * Parse a raw LLM response permissively. Accepts either an already-decoded
   * object or a JSON-encoded string. Each field listed in `missing` is
   * validated individually against its Zod schema - valid fields flow into
   * `values`, invalid ones are dropped and surfaced as warnings. Keys outside
   * `missing` are dropped as well, with a single aggregated warning so the
   * caller can spot a prompt/provider mismatch.
   *
   * Best-effort by design: never throws, always returns an {@link LlmResult}.
   *
   * @typeParam S - A Zod object schema describing the full target shape.
   * @param schema - Zod object schema whose fields back the validation.
   * @param missing - Fields the LLM was expected to produce (typically
   *   {@link ExtractionResult.missing}).
   * @param raw - The provider response - object or JSON string.
   */
  parse<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    missing: readonly (keyof z.infer<S>)[],
    raw: unknown,
  ): LlmResult {
    const missingKeys = missing as readonly string[];
    const decoded = decodeRaw(raw);
    if ('warning' in decoded) {
      return { values: {}, warnings: [decoded.warning] };
    }
    const { values, warnings } = validateMissingFields(
      schema,
      missingKeys,
      decoded.object,
    );
    const unexpected = collectUnexpectedKeys(decoded.object, missingKeys);
    if (unexpected.length > 0) {
      warnings.push(`unexpected fields dropped: ${unexpected.join(', ')}`);
    }
    return warnings.length > 0 ? { values, warnings } : { values };
  },
};
