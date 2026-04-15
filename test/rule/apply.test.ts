import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { rule } from '../../src/rules.js';

const ageSchema = z.object({ age: z.string() });
const personSchema = z.object({
  age: z.string(),
  name: z.string(),
  role: z.string(),
});

const anyAgeRule = rule.regex('age', /(\d+)\s*years/, 1.0);
const writtenAgeRule = rule.regex('age', /aged\s+(\d+)/, 0.5);
const statedAgeRule = rule.regex('age', /is\s+(\d+)\s+year/, 0.9);
const reportedAgeRule = rule.regex('age', /reported\s+(\d+)/, 0.8);
const claimedAgeRule = rule.regex('age', /claims\s+(\d+)/, 0.8);

describe('rule.apply', () => {
  it('returns the matched value in `values`, its confidence in `confidence`, and other schema fields in `missing`', () => {
    const result = rule.apply('Ada, 30 years old', [anyAgeRule], personSchema);

    expect(result.values).toEqual({ age: '30' });
    expect(result.confidence).toEqual({ age: 1.0 });
    expect(result.missing).toEqual(['name', 'role']);
  });

  it('returns every schema field in `missing` when no rules are provided', () => {
    const result = rule.apply('Ada, 30 years old, senior engineer.', [], personSchema);

    expect(result.values).toEqual({});
    expect(result.confidence).toEqual({});
    expect(result.missing).toEqual(['age', 'name', 'role']);
  });

  it('returns every schema field in `missing` when all rules return null on empty content', () => {
    const nullAgeRule = rule.create('age', () => null);
    const nullNameRule = rule.create('name', () => null);

    const result = rule.apply('', [nullAgeRule, nullNameRule], personSchema);

    expect(result.values).toEqual({});
    expect(result.confidence).toEqual({});
    expect(result.missing).toEqual(['age', 'name', 'role']);
  });

  it('silently ignores rules targeting a field absent from the schema', () => {
    const outOfSchemaRule = rule.create('nickname', (text) => {
      const match = text.match(/nickname:\s*(\w+)/);
      if (!match) {
        return null;
      }
      return rule.confidence(match[1]!, 1.0);
    });

    const result = rule.apply('Ada, 30 years old, nickname: Countess', [anyAgeRule, outOfSchemaRule], ageSchema);

    expect(result.values).toEqual({ age: '30' });
    expect(result.confidence).toEqual({ age: 1.0 });
    expect(result.missing).toEqual([]);
  });

  it('keeps the higher-confidence match when two rules target the same field', () => {
    const content = 'aged 25, is 30 years old';

    const result = rule.apply(content, [writtenAgeRule, statedAgeRule], ageSchema);

    expect(result.values).toEqual({ age: '30' });
    expect(result.confidence).toEqual({ age: 0.9 });
    expect(result.missing).toEqual([]);
  });

  it('keeps the first-declared match when two rules on the same field tie on confidence', () => {
    const content = 'reported 25, claims 30';

    const result = rule.apply(content, [reportedAgeRule, claimedAgeRule], ageSchema);

    expect(result.values).toEqual({ age: '25' });
    expect(result.confidence).toEqual({ age: 0.8 });
  });

  it('keeps the earlier match when a later rule on the same field returns null', () => {
    const content = 'aged 25';

    const result = rule.apply(content, [writtenAgeRule, statedAgeRule], ageSchema);

    expect(result.values).toEqual({ age: '25' });
    expect(result.confidence).toEqual({ age: 0.5 });
  });
});
