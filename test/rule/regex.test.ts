import { describe, it, expect } from 'vitest';
import { rule } from '../../src/rules.js';

describe('rule.regex', () => {
  it('produces a match with the transformed value when the pattern matches', () => {
    const ageRule = rule.regex('age', /(\d+)\s*years/, 1.0, (match) => parseInt(match[1]!, 10));

    expect(ageRule.field).toBe('age');
    expect(ageRule.extract('Ada, 30 years old')).toEqual({ value: 30, confidence: 1.0 });
  });

  it('returns match[1] as a string when no transform is given', () => {
    const unitRule = rule.regex('unit', /(cm|mm|m)\b/, 1.0);

    expect(unitRule.extract('Length: 42 cm')).toEqual({ value: 'cm', confidence: 1.0 });
  });

  it('produces no match when the pattern does not match', () => {
    const ageRule = rule.regex('age', /(\d+)\s*years/, 1.0);

    expect(ageRule.extract('no age reported')).toBeNull();
  });
});
