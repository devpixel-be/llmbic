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
];

describe('createExtractor — batch-mode sync methods', () => {
  it('chains extractSync → prompt → parse → merge without involving the provider', () => {
    const extractor = createExtractor({ schema: personSchema, rules: personRules });
    const content = 'Ada, 30 years old, senior engineer.';

    const partial = extractor.extractSync(content);
    expect(partial.data).toEqual({ name: 'Ada', age: 30, role: null });
    expect(partial.missing).toEqual(['role']);
    expect(partial.meta.llmCalled).toBe(false);

    const request = extractor.prompt(content, partial);
    expect(request.knownValues).toEqual({ name: 'Ada', age: 30 });
    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role'],
    });

    const llmResult = extractor.parse('{"role": "senior engineer"}');
    expect(llmResult.values).toEqual({ role: 'senior engineer' });

    const result = extractor.merge(partial, llmResult, content);
    expect(result.data).toEqual({ name: 'Ada', age: 30, role: 'senior engineer' });
    expect(result.missing).toEqual([]);
    expect(result.meta.llmCalled).toBe(true);
  });
});
