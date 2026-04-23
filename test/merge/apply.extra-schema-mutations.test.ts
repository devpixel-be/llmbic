import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { merge, defineNormalizer } from '../../src/merge.js';
import type { RulesResult } from '../../src/types/rule.types.js';
import type { ExtractedData, Normalizer } from '../../src/types/merge.types.js';

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

describe('merge.apply - normalizerMutations (extra-schema keys)', () => {
  it('records an extra-schema key newly added by a normalizer with before: undefined', () => {
    function attachArea(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      if (data.width !== null && data.height !== null) {
        record.area = data.width * data.height;
      }
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [attachArea],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'attachArea',
        field: 'area',
        before: undefined,
        after: 12000,
        step: 0,
      },
    ]);
  });

  it('records a mutation on a pre-existing extra-schema key', () => {
    const seeded = {
      values: { width: 10, height: 10 },
      confidence: { width: 1.0, height: 1.0 },
      missing: [],
    } satisfies RulesResult<Rectangle>;
    function bumpTag(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      record.tag = typeof record.tag === 'string' ? `${record.tag}!` : 'seed!';
      return data;
    }
    function seed(data: ExtractedData<Rectangle>) {
      (data as Record<string, unknown>).tag = 'seed';
      return data;
    }

    const result = merge.apply(rectangleSchema, seeded, null, content, {
      normalizers: [seed, bumpTag],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'seed',
        field: 'tag',
        before: undefined,
        after: 'seed',
        step: 0,
      },
      {
        normalizerId: 'bumpTag',
        field: 'tag',
        before: 'seed',
        after: 'seed!',
        step: 1,
      },
    ]);
  });

  it('records a deletion as after: undefined', () => {
    function seed(data: ExtractedData<Rectangle>) {
      (data as Record<string, unknown>).tmp = 'value';
      return data;
    }
    function strip(data: ExtractedData<Rectangle>) {
      delete (data as Record<string, unknown>).tmp;
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [seed, strip],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'seed',
        field: 'tmp',
        before: undefined,
        after: 'value',
        step: 0,
      },
      {
        normalizerId: 'strip',
        field: 'tmp',
        before: 'value',
        after: undefined,
        step: 1,
      },
    ]);
  });

  it('chains two normalizers mutating the same extra-schema key with the correct steps', () => {
    function addOne(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      record.counter = (typeof record.counter === 'number' ? record.counter : 0) + 1;
      return data;
    }
    function addTen(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      record.counter = (typeof record.counter === 'number' ? record.counter : 0) + 10;
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [addOne, addTen],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'addOne',
        field: 'counter',
        before: undefined,
        after: 1,
        step: 0,
      },
      {
        normalizerId: 'addTen',
        field: 'counter',
        before: 1,
        after: 11,
        step: 1,
      },
    ]);
  });

  it('records mutations on both a schema field and an extra-schema key in a single pass', () => {
    function touchBoth(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      if (data.width !== null) data.width = 999;
      record.derived = 'x';
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [touchBoth],
    });

    expect(result.normalizerMutations).toHaveLength(2);
    expect(result.normalizerMutations).toEqual(
      expect.arrayContaining([
        {
          normalizerId: 'touchBoth',
          field: 'width',
          before: 150,
          after: 999,
          step: 0,
        },
        {
          normalizerId: 'touchBoth',
          field: 'derived',
          before: undefined,
          after: 'x',
          step: 0,
        },
      ]),
    );
  });

  it('attributes extra-schema mutations to "anonymous" when the normalizer is an inline arrow', () => {
    const normalizers: Normalizer<Rectangle>[] = [
      (data) => {
        (data as Record<string, unknown>).extra = 42;
        return data;
      },
    ];

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers,
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'anonymous',
        field: 'extra',
        before: undefined,
        after: 42,
        step: 0,
      },
    ]);
  });

  it('honours defineNormalizer for extra-schema mutations', () => {
    const attach = defineNormalizer<Rectangle>('attach-derived', (data) => {
      (data as Record<string, unknown>).derived = true;
      return data;
    });

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [attach],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'attach-derived',
        field: 'derived',
        before: undefined,
        after: true,
        step: 0,
      },
    ]);
  });

  it('emits no mutation when a normalizer returns the same reference untouched (idempotence on the extra-key diff)', () => {
    const identity: Normalizer<Rectangle> = (data) => data;

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [identity, identity, identity],
    });

    expect(result.normalizerMutations).toEqual([]);
  });

  it('does not emit a mutation when an extra-schema key is rewritten to a structurally equal object', () => {
    function seed(data: ExtractedData<Rectangle>) {
      (data as Record<string, unknown>).meta = { source: 'web' };
      return data;
    }
    function cloneMeta(data: ExtractedData<Rectangle>) {
      const record = data as Record<string, unknown>;
      record.meta = { ...(record.meta as Record<string, unknown>) };
      return data;
    }

    const result = merge.apply(rectangleSchema, baseRulesResult, null, content, {
      normalizers: [seed, cloneMeta],
    });

    expect(result.normalizerMutations).toEqual([
      {
        normalizerId: 'seed',
        field: 'meta',
        before: undefined,
        after: { source: 'web' },
        step: 0,
      },
    ]);
  });
});
