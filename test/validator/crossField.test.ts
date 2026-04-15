import { describe, it, expect } from 'vitest';
import { validator } from '../../src/validate.js';

type Range = { min: number; max: number };

describe('validator.of().crossField', () => {
  it('returns one violation without `field` when the check fails, with default severity `error`', () => {
    const { crossField } = validator.of<Range>();
    const minIsLowerThanMax = crossField(
      'range-ordering',
      (data) => data.min <= data.max,
      'min must be lower than or equal to max',
    );

    const violations = minIsLowerThanMax({ min: 10, max: 5 });

    expect(violations).toEqual([
      { rule: 'range-ordering', message: 'min must be lower than or equal to max', severity: 'error' },
    ]);
  });

  it('preserves an explicitly provided `warning` severity', () => {
    const { crossField } = validator.of<Range>();
    const minIsLowerThanMax = crossField(
      'range-ordering',
      (data) => data.min <= data.max,
      'min must be lower than or equal to max',
      'warning',
    );

    const violations = minIsLowerThanMax({ min: 10, max: 5 });

    expect(violations).toEqual([
      { rule: 'range-ordering', message: 'min must be lower than or equal to max', severity: 'warning' },
    ]);
  });
});
