import { describe, it, expect } from 'vitest';
import { rule } from '../../src/rules.js';

describe('rule.create', () => {
  const ageRule = rule.create('age', (text) => {
    const match = text.match(/(\d+)\s*years/);
    if (!match) {
      return null;
    }
    return rule.confidence(parseInt(match[1]!, 10), 1.0);
  });

  it('produces a match with field, value, and confidence when extract returns a value', () => {
    expect(ageRule.field).toBe('age');
    expect(ageRule.extract('Ada, 30 years old')).toEqual({ value: 30, confidence: 1.0 });
  });

  it('produces no match when extract returns null', () => {
    expect(ageRule.extract('no age reported')).toBeNull();
  });
});
