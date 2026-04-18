import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import type { LlmProvider } from '../../src/types/provider.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});

const personRules = [
  rule.regex('name', /^(\w+),/, 0.9),
  rule.regex('age', /(\d+)\s*years/, 0.8, (match) => Number(match[1])),
];

const content = 'Ada, 30 years old, senior engineer.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createExtractor - meta.durationMs', () => {
  it('populates meta.durationMs on extractSync with the wall-clock spent in the call', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1042);
    const extractor = createExtractor({ schema: personSchema, rules: personRules });

    const result = extractor.extractSync(content);

    expect(result.meta.durationMs).toBe(42);
  });

  it('populates meta.durationMs on extract covering rules + provider + final merge', async () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2350);
    const provider: LlmProvider = {
      async complete() {
        return { values: { role: 'senior engineer' } };
      },
    };
    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: { provider },
    });

    const result = await extractor.extract(content);

    expect(result.meta.durationMs).toBe(350);
  });

  it('populates meta.durationMs on the batch-mode merge', () => {
    const extractor = createExtractor({ schema: personSchema, rules: personRules });
    const partial = extractor.extractSync(content);
    const llmResult = { values: { role: 'senior engineer' } };

    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(5008);

    const result = extractor.merge(partial, llmResult, content);

    expect(result.meta.durationMs).toBe(8);
  });
});
