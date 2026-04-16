import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import type { Normalizer } from '../../src/types/merge.types.js';
import type { Validator } from '../../src/types/validate.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});
type Person = z.infer<typeof personSchema>;

const personRules = [
  rule.regex('name', /^(\w+),/, 0.9),
  rule.regex('age', /(\d+)\s*years/, 0.8, (match) => Number(match[1])),
  rule.regex('role', /(\w+\s+engineer)\./, 0.7),
];

const content = 'Ada, 30 years old, senior engineer.';

describe('createExtractor: extractor-level options', () => {
  it('applies configured normalizers to the merged data', () => {
    const upperName: Normalizer<Person> = (data) => ({
      ...data,
      name: data.name !== null ? data.name.toUpperCase() : null,
    });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      normalizers: [upperName],
    });

    const result = extractor.extractSync(content);

    expect(result.data.name).toBe('ADA');
  });

  it('surfaces validator violations in result.validation', () => {
    const mustBeAdult: Validator<{ age: number | null }> = (data) =>
      data.age !== null && data.age < 18
        ? [{ field: 'age', rule: 'adult', message: 'must be >= 18', severity: 'error' }]
        : [];

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      validators: [mustBeAdult],
    });

    const youngResult = extractor.extractSync('Ada, 12 years old, senior engineer.');

    expect(youngResult.validation.valid).toBe(false);
    expect(youngResult.validation.violations).toHaveLength(1);
    expect(youngResult.validation.violations[0]).toMatchObject({
      field: 'age',
      rule: 'adult',
    });
  });

  it('uses the configured policy for rule/LLM fusion', () => {
    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      policy: { strategy: 'prefer-llm' },
    });

    const partial = extractor.extractSync(content);
    const merged = extractor.merge(partial, { values: { age: 42 } }, content);

    expect(merged.data.age).toBe(42);
    expect(merged.conflicts).toEqual([]);
  });

  it('extractor.merge honors configured normalizers and validators', () => {
    const upperRole: Normalizer<Person> = (data) => ({
      ...data,
      role: data.role !== null ? data.role.toUpperCase() : null,
    });
    const mustHaveRole: Validator<{ role: string | null }> = (data) =>
      data.role === null
        ? [{ field: 'role', rule: 'required', message: 'role missing', severity: 'error' }]
        : [];

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      normalizers: [upperRole],
      validators: [mustHaveRole],
    });

    const partial = extractor.extractSync(content);
    const merged = extractor.merge(partial, { values: {} }, content);

    expect(merged.data.role).toBe('SENIOR ENGINEER');
    expect(merged.validation.valid).toBe(true);
  });

  it('forwards the configured logger to rule.apply', () => {
    const warnings: Array<{ message: string; meta?: object }> = [];
    const logger = {
      warn(message: string, meta?: object) {
        warnings.push({ message, meta });
      },
    };
    const badAgeRule = rule.create('age', () => ({
      value: 'forty-two',
      confidence: 0.9,
    }));

    const extractor = createExtractor({
      schema: personSchema,
      rules: [badAgeRule],
      logger,
    });

    extractor.extractSync(content);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('rule value rejected by schema');
    expect(warnings[0]?.meta).toMatchObject({ field: 'age' });
  });
});
