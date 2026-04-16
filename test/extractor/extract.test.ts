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

describe('createExtractor.extract: cross-check mode', () => {
  it('always calls the LLM, even when the rules resolved every field', async () => {
    const nameRule = rule.regex('name', /^(\w+),/, 0.9);
    const ageRule = rule.regex('age', /(\d+)\s*years/, 0.8, (match) => Number(match[1]));
    const roleRule = rule.regex('role', /(\w+\s+engineer)\./, 0.9);

    let capturedRequest: LlmRequest | undefined;
    const provider: LlmProvider = {
      async complete(request) {
        capturedRequest = request;
        return { values: { name: 'Ada', age: 30, role: 'senior engineer' } };
      },
    };

    const extractor = createExtractor({
      schema: personSchema,
      rules: [nameRule, ageRule, roleRule],
      llm: { provider, mode: 'cross-check' },
    });

    const result = await extractor.extract('Ada, 30 years old, senior engineer.');

    expect(result.meta.llmCalled).toBe(true);
    expect(capturedRequest?.responseSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        role: { type: 'string' },
      },
      required: ['name', 'age', 'role'],
      additionalProperties: false,
    });
    expect(capturedRequest?.knownValues).toEqual({});
  });

  it('records a conflict when rules and LLM disagree on a resolved field', async () => {
    const priceSchema = z.object({
      orderNumber: z.string(),
      price: z.number(),
    });
    const priceRules = [
      rule.regex('orderNumber', /Order\s+(\S+)/, 0.95),
      rule.regex('price', /price:\s*(\d+)/, 0.9, (match) => Number(match[1])),
    ];
    const provider: LlmProvider = {
      async complete() {
        return { values: { orderNumber: 'X-1', price: 200 } };
      },
    };

    const extractor = createExtractor({
      schema: priceSchema,
      rules: priceRules,
      llm: { provider, mode: 'cross-check' },
    });

    const result = await extractor.extract('Order X-1 - price: 100');

    expect(result.meta.llmCalled).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      field: 'price',
      ruleValue: 100,
      llmValue: 200,
    });
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
      additionalProperties: false,
    });
    expect(result.data).toEqual({ name: 'Ada', age: 30, role: 'senior engineer' });
    expect(result.missing).toEqual([]);
    expect(result.meta.llmCalled).toBe(true);
    expect(result.confidence.role).toBe(merge.defaultFieldPolicy.defaultLlmConfidence);
  });
});
