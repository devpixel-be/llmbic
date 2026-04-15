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

describe('prompt.build', () => {
  it('restricts the response schema to the missing fields only', () => {
    const partial: Pick<ExtractionResult<Person>, 'data' | 'missing'> = {
      data: { name: 'Ada', age: 30, role: null, email: null },
      missing: ['role', 'email'],
    };

    const request = prompt.build(personSchema, partial, content);

    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['junior', 'senior'] },
        email: { type: ['string', 'null'] },
      },
      required: ['role', 'email'],
    });
  });

  it('formats already-extracted values as hints in the user content', () => {
    const partial: Pick<ExtractionResult<Person>, 'data' | 'missing'> = {
      data: { name: 'Ada', age: 30, role: null, email: null },
      missing: ['role', 'email'],
    };

    const request = prompt.build(personSchema, partial, content);

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
});
