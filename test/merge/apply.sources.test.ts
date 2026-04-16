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

describe('merge.apply: result.sources', () => {
  it('marks rule-only fields with kind=rule and the rule id from rulesResult.sourceIds', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada' },
      confidence: { name: 0.9 },
      sourceIds: { name: 'name-regex' },
      missing: ['age', 'role'],
    };

    const result = merge.apply(personSchema, rulesResult, null, content);

    expect(result.sources.name).toEqual({ kind: 'rule', ruleId: 'name-regex' });
    expect(result.sources.age).toBeNull();
    expect(result.sources.role).toBeNull();
  });

  it('marks llm-only fields with kind=llm and no ruleId', () => {
    const rulesResult: RulesResult<Person> = {
      values: {},
      confidence: {},
      sourceIds: {},
      missing: ['name', 'age', 'role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Grace', age: 42, role: 'principal' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.sources.name).toEqual({ kind: 'llm' });
    expect(result.sources.age).toEqual({ kind: 'llm' });
    expect(result.sources.role).toEqual({ kind: 'llm' });
  });

  it('marks agreed fields with kind=agreement and the rule id', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada', age: 30 },
      confidence: { name: 0.9, age: 0.8 },
      sourceIds: { name: 'name-regex', age: 'age-regex' },
      missing: ['role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Ada', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.sources.name).toEqual({ kind: 'agreement', ruleId: 'name-regex' });
    expect(result.sources.age).toEqual({ kind: 'agreement', ruleId: 'age-regex' });
    expect(result.sources.role).toEqual({ kind: 'llm' });
  });

  it('marks flagged conflicts with kind=flag and the kept rule id', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada' },
      confidence: { name: 0.9 },
      sourceIds: { name: 'name-regex' },
      missing: ['age', 'role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Grace', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content);

    expect(result.sources.name).toEqual({ kind: 'flag', ruleId: 'name-regex' });
  });

  it('uses kind=rule with the rule id when strategy is prefer-rule and values disagree', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada' },
      confidence: { name: 0.9 },
      sourceIds: { name: 'name-regex' },
      missing: ['age', 'role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Grace', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content, {
      policy: { strategy: 'prefer-rule' },
    });

    expect(result.sources.name).toEqual({ kind: 'rule', ruleId: 'name-regex' });
  });

  it('uses kind=llm when strategy is prefer-llm and values disagree', () => {
    const rulesResult: RulesResult<Person> = {
      values: { name: 'Ada' },
      confidence: { name: 0.9 },
      sourceIds: { name: 'name-regex' },
      missing: ['age', 'role'],
    };
    const llmResult: LlmResult = {
      values: { name: 'Grace', age: 30, role: 'senior engineer' },
    };

    const result = merge.apply(personSchema, rulesResult, llmResult, content, {
      policy: { strategy: 'prefer-llm' },
    });

    expect(result.sources.name).toEqual({ kind: 'llm' });
  });

  it('leaves source as null for fields that remain missing', () => {
    const rulesResult: RulesResult<Person> = {
      values: {},
      confidence: {},
      sourceIds: {},
      missing: ['name', 'age', 'role'],
    };

    const result = merge.apply(personSchema, rulesResult, null, content);

    expect(result.sources.name).toBeNull();
    expect(result.sources.age).toBeNull();
    expect(result.sources.role).toBeNull();
  });
});
