import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { prompt } from '../../src/prompt.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.enum(['junior', 'senior']),
  email: z.string().nullable(),
});
type Person = z.infer<typeof personSchema>;

const allMissing: (keyof Person)[] = ['name', 'age', 'role', 'email'];

describe('prompt.parse', () => {
  it('keeps every field when the raw response is a valid object', () => {
    const result = prompt.parse(personSchema, allMissing, {
      name: 'Ada',
      age: 30,
      role: 'senior',
      email: 'ada@example.com',
    });

    expect(result.values).toEqual({
      name: 'Ada',
      age: 30,
      role: 'senior',
      email: 'ada@example.com',
    });
    expect(result.warnings).toBeUndefined();
  });

  it('parses a JSON-encoded string response', () => {
    const raw = JSON.stringify({
      name: 'Ada',
      age: 30,
      role: 'senior',
      email: null,
    });

    const result = prompt.parse(personSchema, allMissing, raw);

    expect(result.values).toEqual({
      name: 'Ada',
      age: 30,
      role: 'senior',
      email: null,
    });
    expect(result.warnings).toBeUndefined();
  });

  it('drops a field whose value does not match its schema and warns', () => {
    const result = prompt.parse(personSchema, allMissing, {
      name: 'Ada',
      age: 'thirty',
      role: 'senior',
      email: null,
    });

    expect(result.values).toEqual({
      name: 'Ada',
      role: 'senior',
      email: null,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(/age/);
  });

  it('returns an empty result with a warning when the raw string is not JSON', () => {
    const result = prompt.parse(
      personSchema,
      allMissing,
      'Ada is a senior engineer',
    );

    expect(result.values).toEqual({});
    expect(result.warnings).toEqual(['response is not valid JSON']);
  });

  it('drops fields outside `missing` and emits a single aggregated warning', () => {
    const missing: (keyof Person)[] = ['role', 'email'];

    const result = prompt.parse(personSchema, missing, {
      name: 'Ada',
      age: 30,
      role: 'senior',
      email: 'ada@example.com',
    });

    expect(result.values).toEqual({
      role: 'senior',
      email: 'ada@example.com',
    });
    expect(result.warnings).toEqual([
      'unexpected fields dropped: name, age',
    ]);
  });
});
