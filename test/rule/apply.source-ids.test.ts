import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { rule } from '../../src/rules.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
});

describe('rule.apply: sourceIds', () => {
  it('auto-generates a stable id when the rule does not declare one', () => {
    const rules = [
      rule.regex('name', /^(\w+),/, 0.9),
      rule.regex('age', /(\d+)\s*years/, 0.8, (m) => Number(m[1])),
    ];

    const result = rule.apply('Ada, 30 years.', rules, personSchema);

    expect(result.sourceIds.name).toBe('name#0');
    expect(result.sourceIds.age).toBe('age#1');
  });

  it('preserves an explicitly declared rule id', () => {
    const rules = [
      rule.create('name', () => ({ value: 'Ada', confidence: 0.9 }), { id: 'name-fallback' }),
    ];

    const result = rule.apply('whatever', rules, personSchema);

    expect(result.sourceIds.name).toBe('name-fallback');
  });

  it('keeps the id of the highest-confidence rule on field collisions', () => {
    const rules = [
      rule.create('name', () => ({ value: 'Low', confidence: 0.5 }), { id: 'low' }),
      rule.create('name', () => ({ value: 'High', confidence: 0.9 }), { id: 'high' }),
    ];

    const result = rule.apply('whatever', rules, personSchema);

    expect(result.values.name).toBe('High');
    expect(result.sourceIds.name).toBe('high');
  });

  it('omits sourceIds for fields no rule produced a value for', () => {
    const rules = [rule.regex('name', /^(\w+),/, 0.9)];

    const result = rule.apply('Ada,', rules, personSchema);

    expect(result.sourceIds.name).toBe('name#0');
    expect(result.sourceIds.age).toBeUndefined();
  });
});
