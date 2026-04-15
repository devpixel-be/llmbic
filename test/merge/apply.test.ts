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

describe('merge.apply', () => {
  it('returns rules values as-is with an empty LLM result shape when llmResult is null', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada', age: 30 },
      confidence: { name: 0.9, age: 0.8 },
      missing: ['role'],
    };

    const result = merge.apply(personSchema, rulesResult, null, content);

    expect(result.data).toEqual({ name: 'Ada', age: 30, role: null });
    expect(result.confidence).toEqual({ name: 0.9, age: 0.8, role: null });
    expect(result.conflicts).toEqual([]);
    expect(result.missing).toEqual(['role']);
    expect(result.validation).toEqual({ valid: true, violations: [] });
    expect(result.meta.rulesMatched).toBe(2);
    expect(result.meta.llmCalled).toBe(false);
  });

  it('fuses rules and LLM into a complete result with agreement confidence when every field agrees', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada', age: 30 },
      confidence: { name: 0.9, age: 0.8 },
      missing: ['role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Ada', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.data).toEqual({ name: 'Ada', age: 30, role: 'senior engineer' });
    expect(result.confidence).toEqual({
      name: merge.defaultFieldPolicy.agreementConfidence,
      age: merge.defaultFieldPolicy.agreementConfidence,
      role: merge.defaultFieldPolicy.defaultLlmConfidence,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.meta.llmCalled).toBe(true);
  });

  it('records a conflict and lowers the confidence of the disagreeing field under the default flag strategy', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada', age: 30 },
      confidence: { name: 0.9, age: 0.8 },
      missing: ['role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Grace', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.data.name).toBe('Ada');
    expect(result.confidence.name).toBe(merge.defaultFieldPolicy.flaggedConfidence);
    expect(result.conflicts).toEqual([
      {
        field: 'name',
        ruleValue: 'Ada',
        ruleConfidence: 0.9,
        llmValue: 'Grace',
      },
    ]);
    expect(result.missing).toEqual([]);
  });

  it('keeps a field in missing with null data and null confidence when neither rules nor LLM provide a value', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada' },
      confidence: { name: 0.9 },
      missing: ['age', 'role'],
    };
    const llmResult: LlmResult = {
      values: { age: 30 },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.data).toEqual({ name: 'Ada', age: 30, role: null });
    expect(result.confidence.role).toBeNull();
    expect(result.missing).toEqual(['role']);
  });
});
