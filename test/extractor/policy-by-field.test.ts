import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});

const personRules = [
  rule.regex('name', /^(\w+),/, 0.9),
  rule.regex('age', /(\d+)\s*years/, 0.8, (match) => Number(match[1])),
  rule.regex('role', /(\w+\s+engineer)\./, 0.7),
];

const content = 'Ada, 30 years old, senior engineer.';

describe('createExtractor: policyByField', () => {
  it('forwards policyByField to merge.apply', () => {
    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      policy: { strategy: 'prefer-rule' },
      policyByField: {
        age: { strategy: 'prefer-llm' },
      },
    });

    const partial = extractor.extractSync(content);
    const merged = extractor.merge(
      partial,
      { values: { name: 'Grace', age: 42, role: 'principal engineer' } },
      content,
    );

    expect(merged.data.name).toBe('Ada');
    expect(merged.data.age).toBe(42);
    expect(merged.data.role).toBe('senior engineer');
    expect(merged.conflicts).toEqual([]);
  });
});
