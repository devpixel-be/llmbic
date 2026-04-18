import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createExtractor } from '../../src/extractor.js';

describe('createExtractor - config validation', () => {
  it('throws when the schema has no fields', () => {
    expect(() => createExtractor({ schema: z.object({}), rules: [] })).toThrow(
      /schema must declare at least one field/i,
    );
  });
});
