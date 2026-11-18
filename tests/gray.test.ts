import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bucketOf, pickVersion } from '../src/core/gray';

describe('gray release', () => {
  it('bucket is stable for the same device', () => {
    const id = 'device-1234-abcd';
    expect(bucketOf(id)).toBe(bucketOf(id));
    expect(bucketOf(id)).toBeGreaterThanOrEqual(0);
    expect(bucketOf(id)).toBeLessThan(100);
  });

  it('0% gives everyone the stable version, 100% gives everyone the new one', () => {
    const id = randomUUID();
    expect(pickVersion(id, '1.0.0', { version: '2.0.0', percent: 0, whitelist: [] }).version).toBe('1.0.0');
    expect(pickVersion(id, '1.0.0', { version: '2.0.0', percent: 100, whitelist: [] }).version).toBe('2.0.0');
  });

  it('whitelist wins even at 0%', () => {
    const r = pickVersion('tester-0001', '1.0.0', { version: '2.0.0', percent: 0, whitelist: ['tester-0001'] });
    expect(r).toMatchObject({ version: '2.0.0', reason: 'whitelist' });
  });

  it('20% rule hits about 20% of devices', () => {
    const n = 20000;
    let hit = 0;
    for (let i = 0; i < n; i++) {
      if (pickVersion(randomUUID(), '1.0.0', { version: '2.0.0', percent: 20, whitelist: [] }).reason === 'bucket') hit++;
    }
    expect(hit / n).toBeGreaterThan(0.18);
    expect(hit / n).toBeLessThan(0.22);
  });

  it('raising the percentage never takes the new version away from a device', () => {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      const at10 = pickVersion(id, '1', { version: '2', percent: 10, whitelist: [] }).version;
      const at50 = pickVersion(id, '1', { version: '2', percent: 50, whitelist: [] }).version;
      if (at10 === '2') expect(at50).toBe('2');
    }
  });
});
