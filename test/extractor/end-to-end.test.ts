import { describe, it, expect } from 'vitest';
import { createExtractor } from '../../src/index.js';
import type { LlmProvider } from '../../src/index.js';
import {
  orderSchema,
  orderRules,
  orderMarkdown,
  orderLlmValues,
} from '../fixtures/order.fixture.js';

describe('createExtractor — end-to-end on a realistic Order fixture', () => {
  it('extracts the four rule-covered fields in rules-only mode and reports the rest as missing', () => {
    const extractor = createExtractor({ schema: orderSchema, rules: orderRules });

    const partial = extractor.extractSync(orderMarkdown);

    expect(partial.data).toMatchObject({
      orderNumber: 'ORD-2026-0412',
      issuedOn: '2026-03-14',
      currency: 'EUR',
      total: 30.3,
      customer: null,
      notes: null,
    });
    expect(partial.missing).toEqual(['customer', 'notes']);
    expect(partial.meta.llmCalled).toBe(false);
    expect(partial.meta.rulesMatched).toBe(4);
  });

  it('fills the missing fields via the LLM fallback and produces a complete ExtractionResult', async () => {
    const provider: LlmProvider = {
      async complete() {
        return { values: orderLlmValues };
      },
    };

    const extractor = createExtractor({
      schema: orderSchema,
      rules: orderRules,
      llm: { provider, systemPrompt: 'Extract the missing order fields.' },
    });

    const result = await extractor.extract(orderMarkdown);

    expect(result.data).toEqual({
      orderNumber: 'ORD-2026-0412',
      issuedOn: '2026-03-14',
      currency: 'EUR',
      total: 30.3,
      customer: orderLlmValues.customer,
      notes: orderLlmValues.notes,
    });
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.validation).toEqual({ valid: true, violations: [] });
    expect(result.meta.llmCalled).toBe(true);
    expect(result.meta.rulesMatched).toBe(4);
  });
});
