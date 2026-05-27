import { describe, it, expect } from 'vitest';
import { merge } from '../../src/merge.js';
import type { Candidate, ReconcilePolicy } from '../../src/types/reconcile.types.js';

/** A tolerance compare: two numbers agree when within 10% of the larger. */
const within10Percent: ReconcilePolicy['compare'] = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  return Math.abs(x - y) <= 0.1 * Math.max(x, y);
};

describe('merge.reconcile', () => {
  it('returns a null outcome when no candidate provided a value', () => {
    const result = merge.reconcile('x', [
      { value: null, confidence: 0.5, source: 'a' },
      { value: undefined, confidence: 0.5, source: 'b' },
    ]);

    expect(result).toEqual({ value: null, confidence: null, source: null, conflicts: [] });
  });

  it('keeps the only present candidate as a single source', () => {
    const result = merge.reconcile('x', [{ value: 42, confidence: 0.8, source: 'a' }], {
      strategy: 'highest-priority',
    });

    expect(result).toEqual({
      value: 42,
      confidence: 0.8,
      source: { kind: 'single', winner: 'a', agreedBy: ['a'], dissentedBy: [] },
      conflicts: [],
    });
  });

  describe('agreement', () => {
    it('boosts confidence and keeps the winner value when two candidates agree (case-insensitive)', () => {
      const result = merge.reconcile(
        'name',
        [
          { value: 'Ada', confidence: 0.6, source: 'rule' },
          { value: 'ada', confidence: 0.7, source: 'llm' },
        ],
        { strategy: 'highest-priority' },
      );

      expect(result).toEqual({
        value: 'Ada',
        confidence: merge.defaultReconcilePolicy.agreementConfidence,
        source: { kind: 'agreement', winner: 'rule', agreedBy: ['rule', 'llm'], dissentedBy: [] },
        conflicts: [],
      });
    });

    it('still flags a dissenter while two others agree', () => {
      const result = merge.reconcile(
        'count',
        [
          { value: 10, confidence: 0.5, source: 'a' },
          { value: 10, confidence: 0.6, source: 'b' },
          { value: 20, confidence: 0.9, source: 'c' },
        ],
        { strategy: 'highest-priority' },
      );

      expect(result.value).toBe(10);
      expect(result.confidence).toBe(merge.defaultReconcilePolicy.agreementConfidence);
      expect(result.source).toEqual({
        kind: 'agreement',
        winner: 'a',
        agreedBy: ['a', 'b'],
        dissentedBy: ['c'],
      });
      expect(result.conflicts).toEqual([
        {
          field: 'count',
          winner: { source: 'a', value: 10, confidence: 0.5 },
          dissenter: { source: 'c', value: 20, confidence: 0.9 },
        },
      ]);
    });

    it('treats values within tolerance as agreement via a custom compare', () => {
      const result = merge.reconcile(
        'amount',
        [
          { value: 653, confidence: 0.6, source: 'a' },
          { value: 680, confidence: 1, source: 'b' },
        ],
        { strategy: 'flag-on-conflict', compare: within10Percent },
      );

      expect(result.value).toBe(653);
      expect(result.confidence).toBe(merge.defaultReconcilePolicy.agreementConfidence);
      expect(result.source?.kind).toBe('agreement');
    });
  });

  describe('strategy selection', () => {
    it('highest-priority keeps the most authoritative candidate', () => {
      const result = merge.reconcile(
        'x',
        [
          { value: 'a', confidence: 0.5, source: 'a', priority: 1 },
          { value: 'b', confidence: 0.5, source: 'b', priority: 9 },
        ],
        { strategy: 'highest-priority' },
      );

      expect(result.value).toBe('b');
    });

    it('highest-confidence keeps the most confident candidate and flags the rest', () => {
      const result = merge.reconcile(
        'x',
        [
          { value: 'a', confidence: 0.4, source: 's1', priority: 5 },
          { value: 'b', confidence: 0.9, source: 's2', priority: 1 },
        ],
        { strategy: 'highest-confidence' },
      );

      expect(result.value).toBe('b');
      expect(result.confidence).toBe(0.9);
      expect(result.source).toEqual({
        kind: 'single',
        winner: 's2',
        agreedBy: ['s2'],
        dissentedBy: ['s1'],
      });
    });
  });

  describe('cascade', () => {
    it('keeps the first tier clearing the threshold', () => {
      const result = merge.reconcile(
        'x',
        [
          { value: 'first', confidence: 1, source: 'tier1' },
          { value: 'second', confidence: 0.8, source: 'tier2' },
        ],
        { strategy: 'cascade', confidentThreshold: 0.9 },
      );

      expect(result.value).toBe('first');
      expect(result.source?.kind).toBe('single');
    });

    it('falls through to a later tier and marks it cascade', () => {
      const result = merge.reconcile(
        'x',
        [
          { value: 'first', confidence: 0.5, source: 'tier1' },
          { value: 'second', confidence: 0.95, source: 'tier2' },
          { value: 'third', confidence: 0.99, source: 'tier3' },
        ],
        { strategy: 'cascade', confidentThreshold: 0.9 },
      );

      expect(result.value).toBe('second');
      expect(result.confidence).toBe(0.95);
      expect(result.source).toEqual({
        kind: 'cascade',
        winner: 'tier2',
        agreedBy: ['tier2'],
        dissentedBy: ['tier1', 'tier3'],
      });
    });

    it('yields nothing when no tier clears the threshold', () => {
      const result = merge.reconcile(
        'x',
        [
          { value: 'a', confidence: 0.3, source: 'tier1' },
          { value: 'b', confidence: 0.5, source: 'tier2' },
        ],
        { strategy: 'cascade', confidentThreshold: 0.9 },
      );

      expect(result).toEqual({ value: null, confidence: null, source: null, conflicts: [] });
    });
  });

  describe('prefer-when-confident', () => {
    it('keeps the top-priority candidate when it clears the threshold', () => {
      const result = merge.reconcile(
        'status',
        [
          { value: 'sold', confidence: 1, source: 'rule' },
          { value: 'available', confidence: 0.7, source: 'llm' },
        ],
        { strategy: 'prefer-when-confident' },
      );

      expect(result.value).toBe('sold');
      expect(result.confidence).toBe(1);
    });

    it('falls back to the lowest-priority candidate when none clear the threshold', () => {
      const result = merge.reconcile(
        'status',
        [
          { value: 'sold', confidence: 0.9, source: 'rule' },
          { value: 'available', confidence: 0.7, source: 'llm' },
        ],
        { strategy: 'prefer-when-confident' },
      );

      expect(result.value).toBe('available');
      expect(result.confidence).toBe(0.7);
    });
  });

  describe('authoritative primary vs cross-checking secondary', () => {
    const reconcile = (primary: Candidate<number>, secondary: Candidate<number>) =>
      merge.reconcile('value', [primary, secondary], { strategy: 'flag-on-conflict' });

    it('two agreeing sources yield maximum confidence', () => {
      const result = reconcile(
        { value: 4, confidence: 0.7, source: 'primary' },
        { value: 4, confidence: 1, source: 'secondary' },
      );

      expect(result.value).toBe(4);
      expect(result.confidence).toBe(merge.defaultReconcilePolicy.agreementConfidence);
      expect(result.source?.kind).toBe('agreement');
    });

    it('the secondary fills a silent primary at its own confidence', () => {
      const result = reconcile(
        { value: null, confidence: 0, source: 'primary' },
        { value: 2, confidence: 1, source: 'secondary' },
      );

      expect(result.value).toBe(2);
      expect(result.confidence).toBe(1);
      expect(result.source).toEqual({
        kind: 'single',
        winner: 'secondary',
        agreedBy: ['secondary'],
        dissentedBy: [],
      });
    });

    it('keeps the authoritative primary and flags the disagreement', () => {
      const result = reconcile(
        { value: 3, confidence: 0.7, source: 'primary' },
        { value: 2, confidence: 1, source: 'secondary' },
      );

      expect(result.value).toBe(3);
      expect(result.confidence).toBe(merge.defaultReconcilePolicy.conflictConfidence);
      expect(result.source).toEqual({
        kind: 'conflict',
        winner: 'primary',
        agreedBy: ['primary'],
        dissentedBy: ['secondary'],
      });
      expect(result.conflicts).toEqual([
        {
          field: 'value',
          winner: { source: 'primary', value: 3, confidence: 0.7 },
          dissenter: { source: 'secondary', value: 2, confidence: 1 },
        },
      ]);
    });

    it('keeps the primary untouched when the secondary is silent', () => {
      const result = reconcile(
        { value: 3, confidence: 0.7, source: 'primary' },
        { value: null, confidence: 0, source: 'secondary' },
      );

      expect(result.value).toBe(3);
      expect(result.confidence).toBe(0.7);
      expect(result.source?.kind).toBe('single');
    });
  });
});
