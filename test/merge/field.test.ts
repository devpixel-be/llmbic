import { describe, it, expect } from 'vitest';
import { merge } from '../../src/merge.js';

describe('merge.field', () => {
  it('returns the rule value and its confidence when no LLM value is provided', () => {
    const result = merge.field('age', { value: 30, confidence: 0.9 }, null);

    expect(result).toEqual({
      value: 30,
      confidence: 0.9,
      conflict: undefined,
    });
  });

  it('returns the LLM value with the default LLM confidence when no rule match is provided', () => {
    const result = merge.field('age', null, 42);

    expect(result).toEqual({
      value: 42,
      confidence: merge.defaultFieldPolicy.defaultLlmConfidence,
      conflict: undefined,
    });
  });

  it('returns the rule value with the agreement confidence when rule and LLM agree case-insensitively', () => {
    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'ada',
    );

    expect(result).toEqual({
      value: 'Ada',
      confidence: merge.defaultFieldPolicy.agreementConfidence,
      conflict: undefined,
    });
  });

  it('returns the rule value with the flagged confidence and records a conflict when rule and LLM disagree under the flag strategy', () => {
    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'Grace',
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

  it('returns the rule value and its confidence with no conflict when rule and LLM disagree under the prefer-rule strategy', () => {
    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'Grace',
      { strategy: 'prefer-rule' },
    );

    expect(result).toEqual({
      value: 'Ada',
      confidence: 0.8,
      conflict: undefined,
    });
  });

  it('returns the LLM value with the default LLM confidence when rule and LLM disagree under the prefer-llm strategy', () => {
    const result = merge.field(
      'name',
      { value: 'Ada', confidence: 0.8 },
      'Grace',
      { strategy: 'prefer-llm' },
    );

    expect(result).toEqual({
      value: 'Grace',
      confidence: merge.defaultFieldPolicy.defaultLlmConfidence,
      conflict: undefined,
    });
  });

  it('treats two numbers with the same value as agreement regardless of decimal notation', () => {
    const result = merge.field(
      'quantity',
      { value: 10, confidence: 0.8 },
      10.0,
    );

    expect(result).toEqual({
      value: 10,
      confidence: merge.defaultFieldPolicy.agreementConfidence,
      conflict: undefined,
    });
  });

  it('treats a string and a number with the same text representation as disagreement', () => {
    const result = merge.field(
      'quantity',
      { value: '10', confidence: 0.8 },
      10,
    );

    expect(result).toEqual({
      value: '10',
      confidence: merge.defaultFieldPolicy.flaggedConfidence,
      conflict: {
        field: 'quantity',
        ruleValue: '10',
        ruleConfidence: 0.8,
        llmValue: 10,
      },
    });
  });

  it('returns null value and null confidence with no conflict when neither source provided a value', () => {
    const result = merge.field('age', null, null);

    expect(result).toEqual({
      value: null,
      confidence: null,
      conflict: undefined,
    });
  });

  it('treats an undefined LLM value as absent on the LLM side', () => {
    const result = merge.field('age', { value: 30, confidence: 0.9 }, undefined);

    expect(result).toEqual({
      value: 30,
      confidence: 0.9,
      conflict: undefined,
    });
  });

  describe('prefer-rule-when-confident', () => {
    it('keeps the rule value when confidence equals the default threshold of 1', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 1 },
        'available',
        { strategy: 'prefer-rule-when-confident' },
      );

      expect(result).toEqual({
        value: 'sold',
        confidence: 1,
        conflict: undefined,
      });
    });

    it('keeps the LLM value when rule confidence is below the default threshold of 1', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 0.9 },
        'available',
        { strategy: 'prefer-rule-when-confident' },
      );

      expect(result).toEqual({
        value: 'available',
        confidence: merge.defaultFieldPolicy.defaultLlmConfidence,
        conflict: undefined,
      });
    });

    it('honours a caller-supplied lower threshold', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 0.8 },
        'available',
        { strategy: 'prefer-rule-when-confident', ruleConfidenceThreshold: 0.75 },
      );

      expect(result).toEqual({
        value: 'sold',
        confidence: 0.8,
        conflict: undefined,
      });
    });

    it('keeps the LLM value when rule confidence is strictly below a caller-supplied threshold', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 0.749 },
        'available',
        { strategy: 'prefer-rule-when-confident', ruleConfidenceThreshold: 0.75 },
      );

      expect(result).toEqual({
        value: 'available',
        confidence: merge.defaultFieldPolicy.defaultLlmConfidence,
        conflict: undefined,
      });
    });

    it('returns the rule value with the agreement confidence when rule and LLM agree, regardless of threshold', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 0.4 },
        'sold',
        { strategy: 'prefer-rule-when-confident' },
      );

      expect(result).toEqual({
        value: 'sold',
        confidence: merge.defaultFieldPolicy.agreementConfidence,
        conflict: undefined,
      });
    });

    it('returns the rule value alone when no LLM value is provided, regardless of threshold', () => {
      const result = merge.field(
        'status',
        { value: 'sold', confidence: 0.2 },
        null,
        { strategy: 'prefer-rule-when-confident' },
      );

      expect(result).toEqual({
        value: 'sold',
        confidence: 0.2,
        conflict: undefined,
      });
    });
  });
});
