import type { z } from 'zod';
import type {
  ExtractedData,
  ExtractionResult,
  LlmResult,
} from './types/merge.types.js';
import type { LlmRequest } from './types/prompt.types.js';

const DEFAULT_SYSTEM_PROMPT =
  'Extract the listed fields from the content as a JSON object.';

type ZodFieldDef = { type: string; [extra: string]: unknown };
type ZodLike = { def: ZodFieldDef };

/**
 * Convert a single Zod field schema to JSON Schema. Throws on any Zod kind
 * outside the documented whitelist (`string`, `number`, `boolean`, `enum`,
 * `nullable`), naming the offending field so the caller can restructure
 * their schema.
 */
function zodFieldToJsonSchema(zodType: ZodLike, field: string): Record<string, unknown> {
  const def = zodType.def;
  const kind = def.type;

  if (kind === 'string') {
    return { type: 'string' };
  }
  if (kind === 'number') {
    return { type: 'number' };
  }
  if (kind === 'boolean') {
    return { type: 'boolean' };
  }
  if (kind === 'enum') {
    const entries = def.entries as Record<string, string | number>;
    return { type: 'string', enum: Object.values(entries) };
  }
  if (kind === 'nullable') {
    const inner = zodFieldToJsonSchema(def.innerType as ZodLike, field);
    if (typeof inner.type !== 'string') {
      throw new Error(`Unsupported nested nullable on field "${field}"`);
    }
    return { ...inner, type: [inner.type, 'null'] };
  }
  throw new Error(`Unsupported Zod type "${kind}" on field "${field}"`);
}

/**
 * Build the JSON Schema handed to the LLM, restricted to the fields the
 * deterministic pass could not produce.
 */
function buildResponseSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  missing: readonly string[],
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const shape = schema.shape as unknown as Record<string, ZodLike>;
  for (const field of missing) {
    const zodField = shape[field];
    if (zodField === undefined) {
      continue;
    }
    properties[field] = zodFieldToJsonSchema(zodField, field);
  }
  return { type: 'object', properties, required: [...missing] };
}

/**
 * Pick the non-null, non-missing entries of the partial result — the values
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
   * Build an LLM request restricted to `partial.missing`. The response schema
   * is a JSON Schema covering only those fields, and values already produced
   * by the deterministic pass are surfaced both as `knownValues` and as a
   * hint block prepended to `userContent`.
   *
   * Orchestration only — the four phases (response-schema build, known-values
   * collection, user-content formatting, request assembly) each live in their
   * own private helper above.
   *
   * @typeParam S - A Zod object schema describing the full target shape.
   * @param schema - Zod object schema that drives the field selection.
   * @param partial - Output of {@link merge.apply} (or any equivalent partial)
   *   — only `data` and `missing` are read.
   * @param content - Original text the request will refer to.
   * @param options - Optional behavior overrides (custom system prompt).
   * @throws When a missing field uses a Zod kind outside the supported
   *   whitelist; the error message names the offending field.
   */
  build<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    partial: Pick<ExtractionResult<z.infer<S>>, 'data' | 'missing'>,
    content: string,
    options?: { systemPrompt?: string },
  ): LlmRequest {
    type Data = z.infer<S>;
    const missing = partial.missing as readonly string[];
    const responseSchema = buildResponseSchema(schema, missing);
    const knownValues = collectKnownValues<Data>(partial.data, partial.missing);
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
   * validated individually against its Zod schema — valid fields flow into
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
   * @param raw - The provider response — object or JSON string.
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
