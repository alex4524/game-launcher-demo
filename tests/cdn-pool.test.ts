import { describe, expect, it } from 'vitest';
import { CdnPool } from '../src/core/cdn-pool';

const A = { id: 'a', name: 'A', url: 'http://a' };
const B = { id: 'b', name: 'B', url: 'http://b' };
const C = { id: 'c', name: 'C', url: 'http://c' };

describe('CdnPool', () => {
  it('picks the fastest source after probing', () => {
    const p = new CdnPool([A, B, C]);
    p.applyProbe({ a: 80, b: 10, c: null });
    expect(p.current().id).toBe('b');
    expect(p.view().find((v) => v.id === 'c')?.status).toBe('down');
  });

  it('starts on the remembered source before any probe', () => {
    expect(new CdnPool([A, B], { remembered: 'b' }).current().id).toBe('b');
  });

  it('stays on the remembered source when it is close to the best', () => {
    const p = new CdnPool([A, B], { remembered: 'b' });
    p.applyProbe({ a: 10, b: 14 });
    expect(p.current().id).toBe('b');
    p.applyProbe({ a: 10, b: 200 });
    expect(p.current().id).toBe('a');
  });

  it('switches after N consecutive failures and comes back after cooldown', () => {
    let now = 0;
    const switches: string[] = [];
    const p = new CdnPool([A, B], { maxFailures: 2, cooldownMs: 1000, now: () => now, onSwitch: (_f, t) => switches.push(t.id) });
    p.applyProbe({ a: 5, b: 50 });
    expect(p.current().id).toBe('a');
    expect(p.reportFailure('a', 'timeout')).toBe(false);
    expect(p.current().id).toBe('a');
    expect(p.reportFailure('a', 'timeout')).toBe(true);
    expect(p.current().id).toBe('b');
    expect(switches).toEqual(['b']);
    now = 2000; // cooldown over; a probe sees A healthy again
    p.applyProbe({ a: 5, b: 50 });
    expect(p.current().id).toBe('a');
  });

  it('a success resets the failure count and is remembered', () => {
    const remembered: string[] = [];
    const p = new CdnPool([A, B], { maxFailures: 2, onRemember: (id) => remembered.push(id) });
    p.reportFailure('a', 'x');
    p.reportSuccess('a');
    p.reportFailure('a', 'x');
    expect(p.current().id).toBe('a');
    expect(remembered).toEqual(['a']);
  });

  it('when every source is benched, still returns one (soonest to recover)', () => {
    let now = 0;
    const p = new CdnPool([A, B], { maxFailures: 1, cooldownMs: 1000, now: () => now });
    p.reportFailure('a', 'x');
    now = 10;
    p.reportFailure('b', 'x');
    expect(['a', 'b']).toContain(p.current().id);
  });
});
