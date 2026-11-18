import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimiter } from '../src/core/limiter';
import { throttle } from '../src/core/throttle';

describe('throttle (progress push)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs at most once per window and keeps the latest value', () => {
    const seen: number[] = [];
    const f = throttle((n: number) => seen.push(n), 100);
    for (let i = 1; i <= 1000; i++) f(i); // 1000 progress events in the same tick
    expect(seen).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([1, 1000]);
  });

  it('flush delivers the pending value immediately', () => {
    const seen: number[] = [];
    const f = throttle((n: number) => seen.push(n), 100);
    f(1);
    f(2);
    f.flush();
    expect(seen).toEqual([1, 2]);
  });
});

describe('limiter (download concurrency)', () => {
  it('never runs more than max tasks at once', async () => {
    const lim = createLimiter(3);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all(Array.from({ length: 20 }, () => lim.run(task)));
    expect(peak).toBe(3);
  });

  it('a failing task does not block the queue', async () => {
    const lim = createLimiter(1);
    const results = await Promise.allSettled([
      lim.run(async () => {
        throw new Error('boom');
      }),
      lim.run(async () => 'ok'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});
