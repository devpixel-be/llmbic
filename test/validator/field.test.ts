import { describe, it, expect } from 'vitest';
import { validator } from '../../src/validate.js';

type Person = { age: number; name: string };

describe('validator.of().field', () => {
  it('returns no violation when the check passes', () => {
    const { field } = validator.of<Person>();
    const ageIsPositive = field(
      'age',
      'age-positive',
      (value) => value > 0,
      'age must be positive',
    );

    const violations = ageIsPositive({ age: 30, name: 'Ada' });

    expect(violations).toEqual([]);
  });

  it('returns one violation with field, rule, message and default severity `error` when the check fails', () => {
    const { field } = validator.of<Person>();
    const ageIsPositive = field(
      'age',
      'age-positive',
      (value) => value > 0,
      'age must be positive',
    );

    const violations = ageIsPositive({ age: -5, name: 'Ada' });

    expect(violations).toEqual([
      { field: 'age', rule: 'age-positive', message: 'age must be positive', severity: 'error' },
    ]);
  });
});
