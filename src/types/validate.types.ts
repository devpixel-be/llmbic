/**
 * Gravity level of a validation violation. `'error'` invalidates the
 * result; `'warning'` surfaces the issue without marking the result invalid.
 */
export type Severity = 'error' | 'warning';

/**
 * A single rule failure produced by a {@link Validator}.
 */
export type Violation = {
  /** Field the violation refers to. Omitted for cross-field violations. */
  field?: string;
  /** Stable identifier of the rule that fired, for grouping and filtering. */
  rule: string;
  /** Human-readable explanation of the failure. */
  message: string;
  /** Whether the violation is an error or a warning. */
  severity: Severity;
};

/**
 * A function that inspects a data object and returns zero or more violations.
 *
 * @typeParam T - Shape of the data the validator inspects.
 */
export type Validator<T> = (data: T) => Violation[];
