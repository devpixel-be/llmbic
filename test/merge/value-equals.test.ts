import { describe, it, expect } from 'vitest';
import { valueEquals } from '../../src/utils/value-equals.js';

describe('valueEquals', () => {
  it('treats strictly-equal primitives as equal', () => {
    expect(valueEquals(1, 1)).toBe(true);
    expect(valueEquals('a', 'a')).toBe(true);
    expect(valueEquals(true, true)).toBe(true);
    expect(valueEquals(null, null)).toBe(true);
    expect(valueEquals(undefined, undefined)).toBe(true);
  });

  it('distinguishes null, undefined and 0 / empty string', () => {
    expect(valueEquals(null, undefined)).toBe(false);
    expect(valueEquals(0, null)).toBe(false);
    expect(valueEquals('', null)).toBe(false);
    expect(valueEquals(0, '')).toBe(false);
  });

  it('returns false when comparing a primitive with an object', () => {
    expect(valueEquals(1, { a: 1 })).toBe(false);
    expect(valueEquals([1], 1)).toBe(false);
  });

  it('compares arrays structurally, including nested arrays and objects', () => {
    expect(valueEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valueEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(valueEquals([1, { a: 1 }], [1, { a: 1 }])).toBe(true);
    expect(valueEquals([1, { a: 1 }], [1, { a: 2 }])).toBe(false);
  });

  it('distinguishes arrays from plain objects even with matching indexed keys', () => {
    expect(valueEquals([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
  });

  it('compares plain objects by their key set and values', () => {
    expect(valueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valueEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(valueEquals({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('compares objects with null prototypes', () => {
    const a = Object.assign(Object.create(null), { x: 1 });
    const b = Object.assign(Object.create(null), { x: 1 });
    expect(valueEquals(a, b)).toBe(true);
  });

  it('compares Date instances via the JSON fallback', () => {
    const a = new Date('2026-04-23T00:00:00Z');
    const b = new Date('2026-04-23T00:00:00Z');
    const c = new Date('2026-04-24T00:00:00Z');
    expect(valueEquals(a, b)).toBe(true);
    expect(valueEquals(a, c)).toBe(false);
  });

  it('falls back to reference equality for circular structures without throwing', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const b: Record<string, unknown> = { x: 1 };
    b.self = b;

    expect(() => valueEquals(a, b)).not.toThrow();
    expect(valueEquals(a, b)).toBe(false);
    expect(valueEquals(a, a)).toBe(true);
  });
});
