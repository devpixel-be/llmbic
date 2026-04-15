import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import { merge } from '../../src/merge.js';
import type { LlmProvider } from '../../src/types/provider.types.js';
import type { LlmRequest } from '../../src/types/prompt.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});

const personRules = [
  rule.regex('name', /^(\w+),/, 0.9),
  rule.regex('age', /(\d+)\s*years/, 0.8, (match) => Number(match[1])),
];

describe('createExtractor.extract — rules-only mode', () => {
  it('runs the rules, fuses them against a null LLM result, and returns a full ExtractionResult', async () => {
    const extractor = createExtractor({ schema: personSchema, rules: personRules });

    const result = await extractor.extract('Ada, 30 years old, senior engineer.');

    expect(result.data).toEqual({ name: 'Ada', age: 30, role: null });
    expect(result.confidence).toEqual({ name: 0.9, age: 0.8, role: null });
    expect(result.missing).toEqual(['role']);
    expect(result.conflicts).toEqual([]);
    expect(result.validation).toEqual({ valid: true, violations: [] });
    expect(result.meta.llmCalled).toBe(false);
    expect(result.meta.rulesMatched).toBe(2);
  });
});

describe('createExtractor.extract — full mode with LLM fallback', () => {
  it('asks the provider for missing fields only, parses its response, and returns complete data', async () => {
    let capturedRequest: LlmRequest | undefined;
    const provider: LlmProvider = {
      async complete(request) {
        capturedRequest = request;
        return { values: { role: 'senior engineer' } };
      },
    };

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: { provider, systemPrompt: 'Extract the remaining person fields.' },
    });

    const result = await extractor.extract('Ada, 30 years old, senior engineer.');

    expect(capturedRequest?.systemPrompt).toBe('Extract the remaining person fields.');
    expect(capturedRequest?.knownValues).toEqual({ name: 'Ada', age: 30 });
    expect(capturedRequest?.responseSchema).toEqual({
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role'],
    });
    expect(result.data).toEqual({ name: 'Ada', age: 30, role: 'senior engineer' });
    expect(result.missing).toEqual([]);
    expect(result.meta.llmCalled).toBe(true);
    expect(result.confidence.role).toBe(merge.defaultFieldPolicy.defaultLlmConfidence);
  });
});
