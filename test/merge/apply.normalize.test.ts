import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { merge } from '../../src/merge.js';
import type { RulesResult } from '../../src/types/rule.types.js';
import type { LlmResult, Normalizer } from '../../src/types/merge.types.js';

const rectangleSchema = z.object({
  width: z.number(),
  height: z.number(),
});
type Rectangle = z.infer<typeof rectangleSchema>;

const content = 'Rectangle 150x80 cm, oversized entry in the catalog.';

describe('merge.apply — normalizers', () => {
  it('applies a single normalizer that clamps a field before returning the result', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: { width: 150, height: 80 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    };
    const clampWidth: Normalizer<Rectangle> = (data) => {
      if (data.width !== null && data.width > 100) {
        data.width = 100;
      }
      return data;
    };

    const result = merge.apply(rectangleSchema, rulesResult, null, content, {
      normalizers: [clampWidth],
    });

    expect(result.data).toEqual({ width: 100, height: 80 });
    expect(result.validation.valid).toBe(true);
  });

  it('runs multiple normalizers in their declared order', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: { width: 5, height: 5 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    };
    const addTenToWidth: Normalizer<Rectangle> = (data) => {
      if (data.width !== null) {
        data.width = data.width + 10;
      }
      return data;
    };
    const doubleWidth: Normalizer<Rectangle> = (data) => {
      if (data.width !== null) {
        data.width = data.width * 2;
      }
      return data;
    };

    const result = merge.apply(rectangleSchema, rulesResult, null, content, {
      normalizers: [addTenToWidth, doubleWidth],
    });

    expect(result.data.width).toBe(30);
  });

  it('accepts a normalizer that converts a string LLM value into a valid number under Zod re-validation', () => {
    const rulesResult: RulesResult<Rectangle> = {
      values: {},
      confidence: {},
      missing: ['width', 'height'],
    };
    const llmResult: LlmResult = {
      values: { width: '42', height: 80 },
    };
    const parseWidth: Normalizer<Rectangle> = (data) => {
      const rawWidth = data.width as unknown;
      if (typeof rawWidth === 'string') {
        data.width = Number(rawWidth);
      }
      return data;
    };

    const result = merge.apply(rectangleSchema, rulesResult, llmResult, content, {
      normalizers: [parseWidth],
    });

    expect(result.data).toEqual({ width: 42, height: 80 });
    expect(result.validation.valid).toBe(true);
    expect(result.validation.violations).toEqual([]);
  });
});
