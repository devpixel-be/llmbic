import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { prompt } from '../../src/prompt.js';
import type { ExtractionResult } from '../../src/types/merge.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.enum(['junior', 'senior']),
  email: z.string().nullable(),
});
type Person = z.infer<typeof personSchema>;

const content =
  'Ada, 30 years old, senior engineer, reachable at ada@example.com.';

const personPartial: Pick<ExtractionResult<Person>, 'data' | 'missing'> = {
  data: { name: 'Ada', age: 30, role: null, email: null },
  missing: ['role', 'email'],
};

describe('prompt.build', () => {
  it('restricts the response schema to the missing fields only', () => {
    const request = prompt.build(personSchema, personPartial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['junior', 'senior'] },
        email: { type: ['string', 'null'] },
      },
      required: ['role', 'email'],
      additionalProperties: false,
    });
  });

  it('formats already-extracted values as hints in the user content', () => {
    const request = prompt.build(personSchema, personPartial, content);

    expect(request.knownValues).toEqual({ name: 'Ada', age: 30 });
    expect(request.userContent).toContain('name = "Ada"');
    expect(request.userContent).toContain('age = 30');
    expect(request.userContent).toContain(content);
  });

  it('converts string, number, enum, and nullable Zod types to JSON Schema', () => {
    const partial: Pick<ExtractionResult<Person>, 'data' | 'missing'> = {
      data: { name: null, age: null, role: null, email: null },
      missing: ['name', 'age', 'role', 'email'],
    };

    const request = prompt.build(personSchema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        role: { type: 'string', enum: ['junior', 'senior'] },
        email: { type: ['string', 'null'] },
      },
      required: ['name', 'age', 'role', 'email'],
      additionalProperties: false,
    });
  });

  it('throws when a missing field uses an unsupported Zod type', () => {
    const unsupportedSchema = z.object({
      name: z.string(),
      nickname: z.union([z.string(), z.number()]),
    });
    type Unsupported = z.infer<typeof unsupportedSchema>;
    const partial: Pick<ExtractionResult<Unsupported>, 'data' | 'missing'> = {
      data: { name: null, nickname: null },
      missing: ['name', 'nickname'],
    };

    expect(() => prompt.build(unsupportedSchema, partial, content)).toThrow(
      /nickname/,
    );
  });

  it('converts array of primitives to JSON Schema', () => {
    const schema = z.object({
      tags: z.array(z.string()),
      scores: z.array(z.number()),
      levels: z.array(z.enum(['low', 'high'])),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { tags: null, scores: null, levels: null },
      missing: ['tags', 'scores', 'levels'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        scores: { type: 'array', items: { type: 'number' } },
        levels: {
          type: 'array',
          items: { type: 'string', enum: ['low', 'high'] },
        },
      },
      required: ['tags', 'scores', 'levels'],
      additionalProperties: false,
    });
  });

  it('converts nested object with required and optional fields', () => {
    const schema = z.object({
      surface: z.object({
        value: z.number(),
        unit: z.string(),
        note: z.string().optional(),
      }),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { surface: null },
      missing: ['surface'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        surface: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            unit: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['value', 'unit'],
          additionalProperties: false,
        },
      },
      required: ['surface'],
      additionalProperties: false,
    });
  });

  it('treats top-level optional fields as not-required', () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { name: null, nickname: null },
      missing: ['name', 'nickname'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });

  it('unwraps default-wrapped fields', () => {
    const schema = z.object({
      count: z.number().default(0),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { count: null },
      missing: ['count'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        count: { type: 'number' },
      },
      required: ['count'],
      additionalProperties: false,
    });
  });

  it('supports nullable wrapping array and object', () => {
    const schema = z.object({
      tags: z.array(z.string()).nullable(),
      meta: z.object({ label: z.string() }).nullable(),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { tags: null, meta: null },
      missing: ['tags', 'meta'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        tags: { type: ['array', 'null'], items: { type: 'string' } },
        meta: {
          type: ['object', 'null'],
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
      required: ['tags', 'meta'],
      additionalProperties: false,
    });
  });

  it('cross-check mode covers every schema field in the response schema', () => {
    const request = prompt.build(personSchema, personPartial, content, {
      mode: 'cross-check',
    });

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        role: { type: 'string', enum: ['junior', 'senior'] },
        email: { type: ['string', 'null'] },
      },
      required: ['name', 'age', 'role', 'email'],
      additionalProperties: false,
    });
  });

  it('cross-check unbiased (default) drops knownValues and hint block', () => {
    const request = prompt.build(personSchema, personPartial, content, {
      mode: 'cross-check',
    });

    expect(request.knownValues).toEqual({});
    expect(request.userContent).toBe(content);
    expect(request.userContent).not.toContain('Already extracted');
  });

  it('cross-check biased keeps the hint block like fill-gaps', () => {
    const request = prompt.build(personSchema, personPartial, content, {
      mode: 'cross-check',
      crossCheckHints: 'bias',
    });

    expect(request.knownValues).toEqual({ name: 'Ada', age: 30 });
    expect(request.userContent).toContain('Already extracted');
    expect(request.userContent).toContain('name = "Ada"');
    expect(request.userContent).toContain(content);
  });

  it('fill-gaps mode (default) preserves current behavior', () => {
    const explicit = prompt.build(personSchema, personPartial, content, {
      mode: 'fill-gaps',
    });
    const implicit = prompt.build(personSchema, personPartial, content);

    expect(explicit).toEqual(implicit);
  });

  it('propagates .describe() on a primitive to the JSON Schema', () => {
    const schema = z.object({
      price: z.number().describe('price in EUR, tax included'),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { price: null },
      missing: ['price'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        price: { type: 'number', description: 'price in EUR, tax included' },
      },
      required: ['price'],
      additionalProperties: false,
    });
  });

  it('propagates .describe() on an array root, not on its items', () => {
    const schema = z.object({
      tags: z.array(z.string()).describe('list of tags'),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { tags: null },
      missing: ['tags'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'list of tags',
        },
      },
      required: ['tags'],
      additionalProperties: false,
    });
  });

  it('propagates .describe() on an array item', () => {
    const schema = z.object({
      tags: z.array(z.string().describe('a single tag')),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { tags: null },
      missing: ['tags'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string', description: 'a single tag' },
        },
      },
      required: ['tags'],
      additionalProperties: false,
    });
  });

  it('propagates .describe() on a nullable at root level (not on the inner type)', () => {
    const schema = z.object({
      note: z.string().nullable().describe('optional free text'),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { note: null },
      missing: ['note'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        note: { type: ['string', 'null'], description: 'optional free text' },
      },
      required: ['note'],
      additionalProperties: false,
    });
  });

  it('propagates .describe() on object properties', () => {
    const schema = z.object({
      surface: z.object({
        value: z.number().describe('surface in m²'),
        unit: z.string(),
      }),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { surface: null },
      missing: ['surface'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        surface: {
          type: 'object',
          properties: {
            value: { type: 'number', description: 'surface in m²' },
            unit: { type: 'string' },
          },
          required: ['value', 'unit'],
          additionalProperties: false,
        },
      },
      required: ['surface'],
      additionalProperties: false,
    });
  });

  it('supports optional wrapping array and object', () => {
    const schema = z.object({
      tags: z.array(z.string()).optional(),
      meta: z.object({ label: z.string() }).optional(),
    });
    type Data = z.infer<typeof schema>;
    const partial: Pick<ExtractionResult<Data>, 'data' | 'missing'> = {
      data: { tags: null, meta: null },
      missing: ['tags', 'meta'],
    };

    const request = prompt.build(schema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        meta: {
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    });
  });
});
