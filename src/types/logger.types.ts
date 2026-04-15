/**
 * Minimal logger interface consumed by llmbic internals. Any logger that
 * exposes a `warn` method (and optionally `info`) can be plugged in —
 * pino, winston, `console`, or a test double.
 */
export type Logger = {
  /** Report a non-fatal issue, typically a discarded value or a parse warning. */
  warn(message: string, meta?: object): void;
  /** Report an informational event. Optional. */
  info?(message: string, meta?: object): void;
};
