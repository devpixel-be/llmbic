import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { rule } from '../../src/rules.js';

const schemaExpectingNumber = z.object({ age: z.number() });

describe('rule.apply - schema type-check', () => {
  it('discards a rule match whose value does not satisfy the schema field type', () => {
    const ruleReturnsString = rule.create('age', () => ({ value: '30', confidence: 1.0 }));

    const result = rule.apply('Ada, 30 years old', [ruleReturnsString], schemaExpectingNumber);

    expect(result.values).toEqual({});
    expect(result.confidence).toEqual({});
    expect(result.missing).toEqual(['age']);
  });

  it('keeps a rule match whose value satisfies the schema field type', () => {
    const ruleReturnsNumber = rule.create('age', () => ({ value: 30, confidence: 1.0 }));

    const result = rule.apply('Ada, 30 years old', [ruleReturnsNumber], schemaExpectingNumber);

    expect(result.values).toEqual({ age: 30 });
    expect(result.confidence).toEqual({ age: 1.0 });
    expect(result.missing).toEqual([]);
  });

  it('warns via the logger when a rule match is discarded by the schema type-check', () => {
    const ruleReturnsString = rule.create('age', () => ({ value: '30', confidence: 1.0 }));
    const logger = { warn: vi.fn() };

    rule.apply('Ada, 30 years old', [ruleReturnsString], schemaExpectingNumber, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'rule value rejected by schema',
      expect.objectContaining({ field: 'age', value: '30' }),
    );
  });
});
