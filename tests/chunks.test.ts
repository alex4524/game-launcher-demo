import { describe, expect, it } from 'vitest';
import { parseRangeHeader, rangeHeader, splitRanges } from '../src/core/chunks';

describe('splitRanges', () => {
  it('splits into fixed chunks with a shorter tail', () => {
    expect(splitRanges(10, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
      { index: 2, start: 8, end: 9 },
    ]);
  });
  it('exact multiple has no empty tail', () => {
    expect(splitRanges(8, 4).map((r) => [r.start, r.end])).toEqual([[0, 3], [4, 7]]);
  });
  it('empty file has no chunks', () => {
    expect(splitRanges(0, 4)).toEqual([]);
  });
  it('rejects bad input', () => {
    expect(() => splitRanges(-1, 4)).toThrow();
    expect(() => splitRanges(10, 0)).toThrow();
  });
  it('covers every byte exactly once', () => {
    const size = 5 * 1024 * 1024 + 123;
    const r = splitRanges(size, 1024 * 1024);
    expect(r.reduce((n, x) => n + (x.end - x.start + 1), 0)).toBe(size);
    for (let i = 1; i < r.length; i++) expect(r[i].start).toBe(r[i - 1].end + 1);
  });
});

describe('Range header', () => {
  it('formats inclusive ranges', () => {
    expect(rangeHeader({ start: 0, end: 1023 })).toBe('bytes=0-1023');
  });
  it('parses normal, open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 });
  });
  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseRangeHeader(undefined, 1000)).toBeNull();
    expect(parseRangeHeader('bytes=1000-1001', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=5-1', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRangeHeader('items=0-1', 1000)).toBeNull();
  });
});
