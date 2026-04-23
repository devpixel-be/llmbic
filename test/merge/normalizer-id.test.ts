import { describe, it, expect } from 'vitest';
import { resolveNormalizerId } from '../../src/utils/normalizer-id.js';

describe('resolveNormalizerId', () => {
  it('prefers an explicit non-empty .id property', () => {
    function named() {}
    const withId = Object.assign(named, { id: 'explicit' });

    expect(resolveNormalizerId(withId)).toBe('explicit');
  });

  it('ignores a non-string id and falls back to the function name', () => {
    function named() {}
    const withWrongId = Object.assign(named, { id: 42 });

    expect(resolveNormalizerId(withWrongId)).toBe('named');
  });

  it('ignores an empty-string id and falls back to the function name', () => {
    function named() {}
    const withEmptyId = Object.assign(named, { id: '' });

    expect(resolveNormalizerId(withEmptyId)).toBe('named');
  });

  it('returns the function name when no id is present', () => {
    function myNormalizer() {}

    expect(resolveNormalizerId(myNormalizer)).toBe('myNormalizer');
  });

  it('returns "anonymous" for a function with an empty name and no id', () => {
    const arr = [() => undefined];

    expect(resolveNormalizerId(arr[0])).toBe('anonymous');
  });

  it('returns "anonymous" for a non-function input', () => {
    expect(resolveNormalizerId(null)).toBe('anonymous');
    expect(resolveNormalizerId(undefined)).toBe('anonymous');
    expect(resolveNormalizerId(42)).toBe('anonymous');
    expect(resolveNormalizerId('foo')).toBe('anonymous');
  });
});
