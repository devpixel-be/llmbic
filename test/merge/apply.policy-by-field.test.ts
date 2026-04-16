import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { merge } from '../../src/merge.js';
import type { RulesResult } from '../../src/types/rule.types.js';
import type { LlmResult } from '../../src/types/merge.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});
type Person = z.infer<typeof personSchema>;

const content = 'Ada, 30 years old, senior engineer.';

const rulesResult: RulesResult<Person> = {
  values: { name: 'Ada', age: 30, role: 'senior engineer' },
  confidence: { name: 0.9, age: 0.8, role: 0.7 },
  missing: [],
};
const llmResult: LlmResult = {
  values: { name: 'Grace', age: 42, role: 'principal engineer' },
};

describe('merge.apply: policyByField', () => {
  it('applies per-field policy override on top of defaults when no global policy is set', () => {
    const result = merge.apply(personSchema, rulesResult, llmResult, content, {
      policyByField: {
        name: { strategy: 'prefer-llm' },
      },
    });

    expect(result.data.name).toBe('Grace');
    expect(result.data.age).toBe(30);
    expect(result.data.role).toBe('senior engineer');
    expect(result.conflicts.map((c) => c.field).sort()).toEqual(['age', 'role']);
  });

  it('lets policyByField override the global policy on a per-field basis', () => {
    const result = merge.apply(personSchema, rulesResult, llmResult, content, {
      policy: { strategy: 'prefer-llm' },
      policyByField: {
        name: { strategy: 'prefer-rule' },
      },
    });

    expect(result.data.name).toBe('Ada');
    expect(result.data.age).toBe(42);
    expect(result.data.role).toBe('principal engineer');
    expect(result.conflicts).toEqual([]);
  });

  it('inherits global policy for fields absent from policyByField', () => {
    const result = merge.apply(personSchema, rulesResult, llmResult, content, {
      policy: { strategy: 'prefer-rule' },
      policyByField: {
        age: { strategy: 'flag' },
      },
    });

    expect(result.data.name).toBe('Ada');
    expect(result.data.age).toBe(30);
    expect(result.data.role).toBe('senior engineer');
    expect(result.conflicts).toEqual([
      {
        field: 'age',
        ruleValue: 30,
        ruleConfidence: 0.8,
        llmValue: 42,
      },
    ]);
  });

  it('lets policyByField override individual fields like agreementConfidence', () => {
    const agreeingRules: RulesResult<Person> = {
      values: { name: 'Ada', age: 30, role: 'senior engineer' },
      confidence: { name: 0.9, age: 0.8, role: 0.7 },
      missing: [],
    };
    const agreeingLlm: LlmResult = {
      values: { name: 'Ada', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, agreeingRules, agreeingLlm, content, {
      policyByField: {
        name: { agreementConfidence: 0.5 },
      },
    });

    expect(result.confidence.name).toBe(0.5);
    expect(result.confidence.age).toBe(merge.defaultFieldPolicy.agreementConfidence);
    expect(result.confidence.role).toBe(merge.defaultFieldPolicy.agreementConfidence);
  });
});
