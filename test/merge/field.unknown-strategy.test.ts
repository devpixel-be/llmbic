import { describe, it, expect, vi } from 'vitest';
import { merge } from '../../src/merge.js';
import type { FieldMergePolicy } from '../../src/types/merge.types.js';

describe('merge.field — unknown strategy fallback', () => {
  it('warns the logger and falls back to flag behavior when the strategy slipped past the type system', () => {
    const logger = { warn: vi.fn() };
    const invalidPolicy = { strategy: 'invalid' } as unknown as Partial<FieldMergePolicy>;

    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'Grace',
      invalidPolicy,
      logger,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'unknown conflict strategy, falling back to flag',
      expect.objectContaining({ strategy: 'invalid', field: 'name' }),
    );
    expect(result).toEqual({
      value: 'Ada',
      confidence: merge.defaultFieldPolicy.flaggedConfidence,
      conflict: {
        field: 'name',
        ruleValue: 'Ada',
        ruleConfidence: 0.8,
        llmValue: 'Grace',
      },
    });
  });

  it('still falls back to flag behavior silently when no logger is provided', () => {
    const invalidPolicy = { strategy: 'invalid' } as unknown as Partial<FieldMergePolicy>;

    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'Grace',
      invalidPolicy,
    );

    expect(result.conflict).toEqual({
      field: 'name',
      ruleValue: 'Ada',
      ruleConfidence: 0.8,
      llmValue: 'Grace',
    });
  });
});
