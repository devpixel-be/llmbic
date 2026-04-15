import type { Severity, Validator } from './types/validate.types.js';

/**
 * Namespace bundling the validator builders. Use {@link validator.of} to
 * bind a target data shape and receive narrowed `field` / `crossField`
 * builders.
 */
export const validator = {
  /**
   * Bind a target data shape `T` and return the two validator builders
   * (`field` and `crossField`) narrowed to that shape.
   *
   * Binding `T` upfront lets the builders infer each field's precise type
   * (`T[K]`) from the field name alone, so predicates see `number` or
   * `string` directly instead of an untyped union.
   *
   * @typeParam T - Shape of the data object the validators will inspect.
   * @returns An object exposing `field` and `crossField` validator builders.
   *
   * @example
   * ```ts
   * type Person = { age: number; name: string };
   * const { field, crossField } = validator.of<Person>();
   * const ageIsPositive = field('age', 'age-positive', (value) => value > 0, 'age must be positive');
   * ```
   */
  of<T>(): {
    /**
     * Build a {@link Validator} that inspects a single field.
     *
     * The returned validator calls `check(value, data)` and, if it returns
     * `false`, produces one violation carrying `ruleName`, `message` and
     * `severity`.
     *
     * @typeParam K - Name of the field to inspect (inferred from the literal).
     * @param field - Name of the field to inspect.
     * @param ruleName - Stable identifier of the rule, used for grouping.
     * @param check - Predicate; returns `true` when the value is valid.
     * @param message - Human-readable message attached to the violation.
     * @param severity - Severity of the violation; defaults to `'error'`.
     */
    field<K extends keyof T & string>(
      field: K,
      ruleName: string,
      check: (value: T[K], data: T) => boolean,
      message: string,
      severity?: Severity,
    ): Validator<T>;

    /**
     * Build a {@link Validator} that inspects the data object as a whole and
     * flags a violation not tied to a single field.
     *
     * The returned validator calls `check(data)` and, if it returns `false`,
     * produces one violation without a `field` property.
     *
     * @param ruleName - Stable identifier of the rule, used for grouping.
     * @param check - Predicate; returns `true` when the data is valid.
     * @param message - Human-readable message attached to the violation.
     * @param severity - Severity of the violation; defaults to `'error'`.
     */
    crossField(
      ruleName: string,
      check: (data: T) => boolean,
      message: string,
      severity?: Severity,
    ): Validator<T>;
  } {
    return {
      field(field, ruleName, check, message, severity = 'error') {
        return (data) => {
          if (check(data[field], data)) {
            return [];
          }
          return [{ field, rule: ruleName, message, severity }];
        };
      },
      crossField(ruleName, check, message, severity = 'error') {
        return (data) => {
          if (check(data)) {
            return [];
          }
          return [{ rule: ruleName, message, severity }];
        };
      },
    };
  },
};
