import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { merge } from '../../src/merge.js';
import { validator } from '../../src/validate.js';
import type { RulesResult } from '../../src/types/rule.types.js';
import type { ExtractedData } from '../../src/types/merge.types.js';

const rectangleSchema = z.object({
  width: z.number(),
  height: z.number(),
});
type Rectangle = z.infer<typeof rectangleSchema>;

const content = 'Rectangle with a negative width flagged by QA.';

describe('merge.apply — validators', () => {
  it('marks the result invalid when a validator with severity `error` produces a violation', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: { width: -10, height: 50 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    };
    const { field } = validator.of<ExtractedData<Rectangle>>();
    const widthPositive = field(
      'width',
      'width-positive',
      (value) => value !== null && value > 0,
      'width must be strictly positive',
    );

    const result = merge.apply(rectangleSchema, rulesResult, null, content, {
      validators: [widthPositive],
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.violations).toEqual([
      {
        field: 'width',
        rule: 'width-positive',
        message: 'width must be strictly positive',
        severity: 'error',
      },
    ]);
  });

  it('keeps the result valid when a validator with severity `warning` produces a violation, and still surfaces it', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: { width: -10, height: 50 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    };
    const { field } = validator.of<ExtractedData<Rectangle>>();
    const widthPositive = field(
      'width',
      'width-positive',
      (value) => value !== null && value > 0,
      'width looks suspicious',
      'warning',
    );

    const result = merge.apply(rectangleSchema, rulesResult, null, content, {
      validators: [widthPositive],
    });

    expect(result.validation.valid).toBe(true);
    expect(result.validation.violations).toEqual([
      {
        field: 'width',
        rule: 'width-positive',
        message: 'width looks suspicious',
        severity: 'warning',
      },
    ]);
  });

  it('aggregates violations when several validators flag the same field', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: { width: -10, height: 50 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    };
    const { field } = validator.of<ExtractedData<Rectangle>>();
    const widthPositive = field(
      'width',
      'width-positive',
      (value) => value !== null && value > 0,
      'width must be strictly positive',
    );
    const widthReasonable = field(
      'width',
      'width-reasonable',
      (value) => value !== null && value >= 1 && value <= 1000,
      'width must stay within [1, 1000]',
      'warning',
    );

    const result = merge.apply(rectangleSchema, rulesResult, null, content, {
      validators: [widthPositive, widthReasonable],
    });

    expect(result.validation.valid).toBe(false);
    expect(result.validation.violations).toHaveLength(2);
    expect(result.validation.violations.map((v) => v.rule)).toEqual([
      'width-positive',
      'width-reasonable',
    ]);
  });
});
