import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import type { LlmProvider } from '../../src/types/provider.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});

describe('createExtractor: sources end-to-end', () => {
  it('exposes per-field sources covering rule, llm, agreement and missing kinds', async () => {
    const personRules = [
      rule.regex('name', /^(\w+),/, 0.9, undefined, { id: 'name-regex' }),
      rule.regex('age', /(\d+)\s*years/, 0.8, (m) => Number(m[1]), { id: 'age-regex' }),
    ];

    const provider: LlmProvider = {
      async complete() {
        return { values: { age: 30, role: 'senior engineer' } };
      },
    };

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: { provider, mode: 'cross-check' },
    });

    const result = await extractor.extract('Ada, 30 years old, senior engineer.');

    expect(result.sources.name).toEqual({ kind: 'rule', ruleId: 'name-regex' });
    expect(result.sources.age).toEqual({ kind: 'agreement', ruleId: 'age-regex' });
    expect(result.sources.role).toEqual({ kind: 'llm' });
  });

  it('exposes sources after extractor.merge re-runs the rules from a partial', () => {
    const personRules = [
      rule.regex('name', /^(\w+),/, 0.9, undefined, { id: 'name-regex' }),
    ];

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
    });

    const partial = extractor.extractSync('Ada, 30 years old, senior engineer.');
    const merged = extractor.merge(
      partial,
      { values: { age: 30, role: 'senior engineer' } },
      'Ada, 30 years old, senior engineer.',
    );

    expect(merged.sources.name).toEqual({ kind: 'rule', ruleId: 'name-regex' });
    expect(merged.sources.age).toEqual({ kind: 'llm' });
    expect(merged.sources.role).toEqual({ kind: 'llm' });
  });
});
