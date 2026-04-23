import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { merge, defineNormalizer } from '../../src/merge.js';
import type { RulesResult } from '../../src/types/rule.types.js';
import type { Normalizer } from '../../src/types/merge.types.js';

const rectangleSchema = z.object({
  width: z.number(),
  height: z.number(),
});
type Rectangle = z.infer<typeof rectangleSchema>;

const content = 'Rectangle 150x80 cm.';

const baseRulesResult: RulesResult<Rectangle> = {
  values: { width: 150, height: 80 },
  confidence: { width: 1.0, height: 1.0 },
  missing: [],
};

describe('merge.apply - normalizerMutations', () => {
  it('returns an empty array when no normalizers are configured', () => {
    const result = merge.apply(rectangleSchema, baseRulesResult, null, content);

    expect(result.normalizerMutations).toEqual([]);
  });

  it('returns an empty array when normalizers array is explicitly empty', () => {
    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [],
    });

    expect(result.normalizerMutations).toEqual([]);
  });

  it('records a single mutation with the named-function name for a one-field change', () => {
    function clampWidth(data: { width: number | null; height: number | null }) {
      if (data.width !== null && data.width > 100) {
        data.width = 100;
      }
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [clampWidth],
    });

    expect(result.data).toEqual({ width: 100, height: 80 });
    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'clampWidth',
        field: 'width',
        before: 150,
        after: 100,
        step: 0,
      },
    ]);
  });

  it('emits no mutations when a normalizer returns the data unchanged', () => {
    const identity: Normalizer<Rectangle> = (data) => data;

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [identity],
    });

    expect(result.normalizerMutations).toEqual([]);
  });

  it('records one mutation per step when two normalizers mutate the same field in sequence', () => {
    function addTen(data: { width: number | null; height: number | null }) {
      if (data.width !== null) data.width = data.width + 10;
      return data;
    }
    function double(data: { width: number | null; height: number | null }) {
      if (data.width !== null) data.width = data.width * 2;
      return data;
    }

    const result = merge.apply(
      rectangleSchema,
      {
        values: { width: 5, height: 5 },
        confidence: { width: 1.0, height: 1.0 },
        missing: [],
      },
      null,
      content,
      { normalizers: [addTen, double] },
    );

    expect(result.data.width).toBe(30);
    expect(result.normalizerMutations).toEqual([
      { normalizerId: 'addTen', field: 'width', before: 5, after: 15, step: 0 },
      { normalizerId: 'double', field: 'width', before: 15, after: 30, step: 1 },
    ]);
  });

  it('falls back to "anonymous" for an arrow function with no name and no id', () => {
    const normalizers: Normalizer<Rectangle>[] = [
      (data) => ({ ...data, width: 1 }),
    ];

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers,
    });

    expect(result.normalizerMutations).toHaveLength(1);
    expect(result.normalizerMutations[0]!.normalizerId).toBe('anonymous');
  });

  it('prefers an explicit .id property over the function name', () => {
    function named(data: { width: number | null; height: number | null }) {
      return { ...data, width: 42 };
    }
    const withId = Object.assign(named, { id: 'custom-id' });

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [withId],
    });

    expect(result.normalizerMutations[0]!.normalizerId).toBe('custom-id');
  });

  it('uses the id passed to defineNormalizer', () => {
    const fixWidth = defineNormalizer<Rectangle>('fix-width', (data) => {
      if (data.width !== null) data.width = 7;
      return data;
    });

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [fixWidth],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'fix-width',
        field: 'width',
        before: 150,
        after: 7,
        step: 0,
      },
    ]);
  });

  it('detects array field mutations even when the length stays the same', () => {
    const schema = z.object({ items: z.array(z.string()) });
    const rulesResult: RulesResult<z.infer<typeof schema>> = {
      values: { items: ['a', 'b'] },
      confidence: { items: 1.0 },
      missing: [],
    };
    function swap(data: { items: string[] | null }) {
      if (data.items !== null) data.items = ['a', 'c'];
      return data;
    }

    const result = merge.apply(schema, rulesResult, null, content, {
      normalizers: [swap],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'swap',
        field: 'items',
        before: ['a', 'b'],
        after: ['a', 'c'],
        step: 0,
      },
    ]);
  });

  it('detects deep object mutations via the valueEquals fallback', () => {
    const schema = z.object({ meta: z.object({ source: z.string(), version: z.number() }) });
    const rulesResult: RulesResult<z.infer<typeof schema>> = {
      values: { meta: { source: 'web', version: 1 } },
      confidence: { meta: 1.0 },
      missing: [],
    };
    function bumpVersion(data: { meta: { source: string; version: number } | null }) {
      if (data.meta !== null) {
        data.meta = { ...data.meta, version: 2 };
      }
      return data;
    }

    const result = merge.apply(schema, rulesResult, null, content, {
      normalizers: [bumpVersion],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'bumpVersion',
        field: 'meta',
        before: { source: 'web', version: 1 },
        after: { source: 'web', version: 2 },
        step: 0,
      },
    ]);
  });

  it('does not record a mutation when a normalizer rewrites a field to a structurally equal value', () => {
    const schema = z.object({ meta: z.object({ source: z.string() }) });
    const rulesResult: RulesResult<z.infer<typeof schema>> = {
      values: { meta: { source: 'web' } },
      confidence: { meta: 1.0 },
      missing: [],
    };
    function cloneMeta(data: { meta: { source: string } | null }) {
      if (data.meta !== null) {
        data.meta = { ...data.meta };
      }
      return data;
    }

    const result = merge.apply(schema, rulesResult, null, content, {
      normalizers: [cloneMeta],
    });

    expect(result.normalizerMutations).toEqual([]);
  });

  it('keeps existing ExtractionResult fields intact and only adds normalizerMutations', () => {
    const result = merge.apply(rectangleSchema, baseRulesResult, null, content);

    expect(Object.keys(result).sort()).toEqual(
      [
        'conflicts',
        'confidence',
        'data',
        'meta',
        'missing',
        'normalizerMutations',
        'sources',
        'validation',
      ].sort(),
    );
  });
});
