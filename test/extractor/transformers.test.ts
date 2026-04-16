import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import type { LlmProvider } from '../../src/types/provider.types.js';
import type { LlmRequest } from '../../src/types/prompt.types.js';
import type { LlmResult } from '../../src/types/merge.types.js';

const personSchema = z.object({
  name: z.string(),
  age: z.number(),
  role: z.string(),
});

const personRules = [rule.regex('name', /^(\w+),/, 0.9)];

const content = 'Ada, contact ada@example.com, 30 years, senior engineer.';

function recordingProvider(values: Record<string, unknown>): {
  provider: LlmProvider;
  lastRequest: { value: LlmRequest | null };
} {
  const lastRequest = { value: null as LlmRequest | null };
  return {
    provider: {
      async complete(request) {
        lastRequest.value = request;
        return { values };
      },
    },
    lastRequest,
  };
}

describe('createExtractor: transformers', () => {
  it('passes the request through transformRequest before reaching the provider', async () => {
    const { provider, lastRequest } = recordingProvider({ age: 30, role: 'senior engineer' });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: {
        provider,
        transformRequest: async (request) => ({
          ...request,
          systemPrompt: `Language: en\n${request.systemPrompt}`,
        }),
      },
    });

    await extractor.extract(content);

    expect(lastRequest.value?.systemPrompt.startsWith('Language: en\n')).toBe(true);
  });

  it('lets transformResponse rewrite the LLM result before merge', async () => {
    const { provider } = recordingProvider({ age: 30, role: 'senior engineer' });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: {
        provider,
        transformResponse: async (result): Promise<LlmResult> => ({
          ...result,
          values: { ...result.values, role: 'staff engineer' },
        }),
      },
    });

    const result = await extractor.extract(content);

    expect(result.data.role).toBe('staff engineer');
    expect(result.data.age).toBe(30);
  });

  it('behaves identically to 1.1.0 when no transformers are configured', async () => {
    const { provider } = recordingProvider({ age: 30, role: 'senior engineer' });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: { provider },
    });

    const result = await extractor.extract(content);

    expect(result.data).toEqual({ name: 'Ada', age: 30, role: 'senior engineer' });
  });

  it('propagates errors thrown by transformRequest without catching them', async () => {
    const { provider } = recordingProvider({ age: 30, role: 'senior engineer' });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: {
        provider,
        transformRequest: () => {
          throw new Error('redaction service down');
        },
      },
    });

    await expect(extractor.extract(content)).rejects.toThrow('redaction service down');
  });

  it('demonstrates the PII-redaction pattern: redact in request, restore in response', async () => {
    const { provider, lastRequest } = recordingProvider({
      age: 30,
      role: 'senior engineer at <EMAIL_0>',
    });

    const extractor = createExtractor({
      schema: personSchema,
      rules: personRules,
      llm: {
        provider,
        transformRequest: (request) => {
          const emails: string[] = [];
          const userContent = request.userContent.replace(
            /[\w.+-]+@[\w.-]+/g,
            (match) => {
              const i = emails.length;
              emails.push(match);
              return `<EMAIL_${i}>`;
            },
          );
          return { ...request, userContent, knownValues: { ...request.knownValues, _emails: emails } };
        },
        transformResponse: (result, request) => {
          const emails = (request.knownValues._emails as string[]) ?? [];
          const restore = (value: unknown): unknown =>
            typeof value === 'string'
              ? value.replace(/<EMAIL_(\d+)>/g, (_, i) => emails[Number(i)] ?? `<EMAIL_${i}>`)
              : value;
          const values = Object.fromEntries(
            Object.entries(result.values).map(([k, v]) => [k, restore(v)]),
          );
          return { ...result, values };
        },
      },
    });

    const result = await extractor.extract(content);

    expect(lastRequest.value?.userContent).not.toContain('ada@example.com');
    expect(lastRequest.value?.userContent).toContain('<EMAIL_0>');
    expect(result.data.role).toBe('senior engineer at ada@example.com');
  });
});
