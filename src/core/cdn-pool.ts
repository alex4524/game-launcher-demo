import type { CdnSource, CdnView } from '../shared/types';

export interface CdnPoolOptions {
  /** Source that worked last time (persisted by the caller). */
  remembered?: string | null;
  /** Consecutive failures before a source is benched. */
  maxFailures?: number;
  /** How long a benched source is skipped, ms. */
  cooldownMs?: number;
  /** Keep the remembered source after a probe if it is at most this many times slower than the best. */
  stickyFactor?: number;
  now?: () => number;
  onSwitch?: (from: CdnSource | null, to: CdnSource, reason: string) => void;
  onRemember?: (id: string) => void;
}

interface Entry {
  src: CdnSource;
  latencyMs: number | null;
  status: 'unknown' | 'ok' | 'down';
  failures: number;
  benchedUntil: number;
}

/**
 * Picks which CDN to download from.
 * - probe(): measure latency of every source, choose the fastest (sticky to the remembered one if close).
 * - reportFailure(): N consecutive failures bench a source for a while and switch to the next best.
 * - reportSuccess(): resets the failure count and remembers the source for next launch.
 */
export class CdnPool {
  private entries: Entry[];
  private activeId: string | null = null;
  private remembered: string | null;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly stickyFactor: number;
  private readonly now: () => number;

  constructor(sources: CdnSource[], private readonly opts: CdnPoolOptions = {}) {
    if (sources.length === 0) throw new Error('no CDN sources');
    this.entries = sources.map((src) => ({ src, latencyMs: null, status: 'unknown', failures: 0, benchedUntil: 0 }));
    this.remembered = opts.remembered && sources.some((s) => s.id === opts.remembered) ? opts.remembered : null;
    this.maxFailures = opts.maxFailures ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.stickyFactor = opts.stickyFactor ?? 1.5;
    this.now = opts.now ?? Date.now;
    // Before any probe, start on the remembered source so the first request does not wait.
    this.activeId = this.remembered ?? sources[0].id;
  }

  /** Apply probe results: latency in ms, or null when the source did not answer. */
  applyProbe(results: Record<string, number | null>): void {
    for (const e of this.entries) {
      if (!(e.src.id in results)) continue;
      const ms = results[e.src.id];
      e.latencyMs = ms;
      e.status = ms === null ? 'down' : 'ok';
      if (ms !== null) {
        e.failures = 0;
        e.benchedUntil = 0;
      }
    }
    const ranked = this.ranked();
    const best = ranked[0];
    const mem = this.entries.find((e) => e.src.id === this.remembered);
    let pick = best;
    if (mem && mem.status === 'ok' && best.latencyMs !== null && mem.latencyMs !== null) {
      if (mem.latencyMs <= Math.max(best.latencyMs * this.stickyFactor, best.latencyMs + 20)) pick = mem;
    }
    this.switchTo(pick, 'probe');
  }

  current(): CdnSource {
    const e = this.entries.find((x) => x.src.id === this.activeId)!;
    if (this.isBenched(e)) {
      const next = this.ranked()[0];
      this.switchTo(next, `${e.src.name} benched`);
      return next.src;
    }
    return e.src;
  }

  reportSuccess(id: string): void {
    const e = this.find(id);
    if (!e) return;
    e.failures = 0;
    if (e.status !== 'ok') e.status = 'ok';
    if (this.remembered !== id) {
      this.remembered = id;
      this.opts.onRemember?.(id);
    }
  }

  /** Returns true when this failure benched the source. */
  reportFailure(id: string, reason: string): boolean {
    const e = this.find(id);
    if (!e) return false;
    if (this.isBenched(e)) return false;
    e.failures++;
    if (e.failures < this.maxFailures) return false;
    e.status = 'down';
    e.benchedUntil = this.now() + this.cooldownMs;
    if (this.activeId === id) {
      const next = this.ranked()[0];
      this.switchTo(next, `${e.src.name} failed ${e.failures}x (${reason})`);
    }
    return true;
  }

  view(): CdnView[] {
    return this.entries.map((e) => ({
      ...e.src,
      latencyMs: e.latencyMs,
      status: this.isBenched(e) ? 'down' : e.status,
      active: e.src.id === this.activeId,
      failures: e.failures,
      remembered: e.src.id === this.remembered,
    }));
  }

  get sources(): CdnSource[] {
    return this.entries.map((e) => e.src);
  }

  /** Usable sources first (by latency), benched ones last (soonest back first). */
  private ranked(): Entry[] {
    return [...this.entries].sort((a, b) => {
      const ab = this.isBenched(a);
      const bb = this.isBenched(b);
      if (ab !== bb) return ab ? 1 : -1;
      if (ab && bb) return a.benchedUntil - b.benchedUntil;
      const ad = a.status === 'down';
      const bd = b.status === 'down';
      if (ad !== bd) return ad ? 1 : -1;
      return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
    });
  }

  private isBenched(e: Entry): boolean {
    return e.benchedUntil > this.now();
  }

  private find(id: string): Entry | undefined {
    return this.entries.find((e) => e.src.id === id);
  }

  private switchTo(e: Entry, reason: string): void {
    if (e.src.id === this.activeId) return;
    const from = this.entries.find((x) => x.src.id === this.activeId)?.src ?? null;
    this.activeId = e.src.id;
    this.opts.onSwitch?.(from, e.src, reason);
  }
}

/** Measure round-trip time of GET <url>/ping, median of `rounds`. null = unreachable. */
export async function probeLatency(url: string, timeoutMs = 1500, rounds = 3): Promise<number | null> {
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      await res.arrayBuffer();
      if (!res.ok) return null;
      samples.push(performance.now() - t0);
    } catch {
      return null;
    }
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]);
}
