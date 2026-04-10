import { describe, it, expect } from 'vitest';
import { appendAll } from '../../src/lib/array-utils.js';

describe('appendAll', () => {
  it('appends all elements from source to target', () => {
    const target = [1, 2];
    const src = [3, 4, 5];
    appendAll(target, src);
    expect(target).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty source', () => {
    const target = [1];
    appendAll(target, []);
    expect(target).toEqual([1]);
  });

  it('handles empty target', () => {
    const target: number[] = [];
    appendAll(target, [1, 2]);
    expect(target).toEqual([1, 2]);
  });

  it('does not stack-overflow on large arrays', () => {
    const target: number[] = [];
    const src = Array.from({ length: 100_000 }, (_, i) => i);
    expect(() => appendAll(target, src)).not.toThrow();
    expect(target.length).toBe(100_000);
  });
});
