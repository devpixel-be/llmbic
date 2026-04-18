import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';
import { rule } from '../../src/rules.js';
import type { LlmProvider } from '../../src/types/provider.types.js';
import type { ExtractorLlmConfig } from '../../src/types/extractor.types.js';
import type { RuleMatch } from '../../src/types/rule.types.js';

type Region = { region: 'us' | 'uk' };

const priceSchema = z.object({ price: z.string() });
const CONTENT = 'any content';

const buildExtractor = (
  extract: (content: string, context?: Region) => RuleMatch<unknown> | null,
  llm?: ExtractorLlmConfig,
) =>
  createExtractor<typeof priceSchema, Region>({
    schema: priceSchema,
    rules: [rule.create<Region>('price', extract)],
    ...(llm !== undefined ? { llm } : {}),
  });

describe('createExtractor: context forwarding', () => {
  it('forwards context through extract() to every rule.extract callback', async () => {
    const extract = vi.fn((_content: string, context?: Region) => {
      return context?.region === 'uk' ? rule.confidence('42 GBP', 1) : null;
    });

    const result = await buildExtractor(extract).extract(CONTENT, { region: 'uk' });

    expect(extract).toHaveBeenCalledWith(CONTENT, { region: 'uk' });
    expect(result.data).toEqual({ price: '42 GBP' });
  });

  it('forwards context through extractSync() as well', () => {
    const extract = vi.fn((_content: string, context?: Region) => {
      return context?.region === 'us' ? rule.confidence('42 USD', 1) : null;
    });

    const result = buildExtractor(extract).extractSync(CONTENT, { region: 'us' });

    expect(extract).toHaveBeenCalledWith(CONTENT, { region: 'us' });
    expect(result.data).toEqual({ price: '42 USD' });
  });

  it('leaves context undefined on every rule call when the caller passes none (back-compat)', async () => {
    const extract = vi.fn(() => rule.confidence('ok', 1));

    await buildExtractor(extract).extract(CONTENT);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith(CONTENT, undefined);
  });

  it('still forwards context to rules when an LLM fallback is configured', async () => {
    const provider: LlmProvider = {
      complete: vi.fn(async () => ({ values: { price: 'from-llm' } })),
    };
    const extract = vi.fn((_content: string, context?: Region) => {
      return context?.region === 'uk' ? rule.confidence('42 GBP', 1) : null;
    });

    await buildExtractor(extract, { provider }).extract(CONTENT, { region: 'uk' });

    expect(extract).toHaveBeenCalledWith(CONTENT, { region: 'uk' });
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
