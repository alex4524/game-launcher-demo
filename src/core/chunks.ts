export interface ByteRange {
  index: number;
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive (HTTP Range semantics). */
  end: number;
}

/** Split a file of `size` bytes into fixed-size chunks; the last one may be shorter. */
export function splitRanges(size: number, chunkSize: number): ByteRange[] {
  if (!Number.isInteger(size) || size < 0) throw new Error(`bad size ${size}`);
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error(`bad chunkSize ${chunkSize}`);
  const out: ByteRange[] = [];
  for (let start = 0, index = 0; start < size; start += chunkSize, index++) {
    out.push({ index, start, end: Math.min(start + chunkSize, size) - 1 });
  }
  return out;
}

export function rangeHeader(r: { start: number; end: number }): string {
  return `bytes=${r.start}-${r.end}`;
}

/**
 * Parse a single-range `Range` header against a resource of `size` bytes.
 * Returns null when the header is absent, malformed, multi-range or unsatisfiable.
 */
export function parseRangeHeader(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return null;
  if (a === '') {
    // suffix range: last N bytes
    const n = Number(b);
    if (n === 0) return null;
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}
