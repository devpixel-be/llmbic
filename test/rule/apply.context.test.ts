import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { rule } from '../../src/rules.js';
import type { ExtractionRule, RuleMatch } from '../../src/types/rule.types.js';

type Region = { region: 'us' | 'uk' };

const priceSchema = z.object({ price: z.string() });
const CONTENT = 'any content';

const priceRule = (
  extract: (content: string, context?: Region) => RuleMatch<unknown> | null,
): ExtractionRule<Region> => rule.create<Region>('price', extract);

describe('rule.apply: context', () => {
  it('leaves context undefined when the caller does not pass one (back-compat)', () => {
    const extract = vi.fn(() => rule.confidence('ok', 1));

    const result = rule.apply(CONTENT, [priceRule(extract)], priceSchema);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith(CONTENT, undefined);
    expect(result.values).toEqual({ price: 'ok' });
  });

  it('forwards the caller-provided context verbatim to every rule.extract call', () => {
    const extract = vi.fn((_content: string, context?: Region) => {
      return context?.region === 'uk' ? rule.confidence('42 GBP', 1) : null;
    });

    const result = rule.apply(CONTENT, [priceRule(extract)], priceSchema, undefined, { region: 'uk' });

    expect(extract).toHaveBeenCalledWith(CONTENT, { region: 'uk' });
    expect(result.values).toEqual({ price: '42 GBP' });
  });

  it('tolerates rules that ignore the context parameter even when one is provided', () => {
    const contextAwareSpy = vi.fn((_content: string, context?: Region) => {
      return context?.region === 'us' ? rule.confidence('42 USD', 1) : null;
    });
    const contextUnawareSpy = vi.fn(() => rule.confidence('fallback', 0.5));
    const context: Region = { region: 'us' };

    const result = rule.apply(
      CONTENT,
      [priceRule(contextAwareSpy), priceRule(contextUnawareSpy)],
      priceSchema,
      undefined,
      context,
    );

    expect(contextAwareSpy).toHaveBeenCalledWith(CONTENT, context);
    expect(contextUnawareSpy).toHaveBeenCalledWith(CONTENT, context);
    expect(result.values).toEqual({ price: '42 USD' });
    expect(result.confidence).toEqual({ price: 1 });
  });
});
