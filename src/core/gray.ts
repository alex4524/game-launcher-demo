import { createHash } from 'node:crypto';
import type { GrayReason } from '../shared/types';

export interface GrayRule {
  /** Version handed to devices that hit the rule. */
  version: string;
  /** 0-100: share of devices (by hash bucket) that get `version`. */
  percent: number;
  /** Device IDs that always get `version` (internal testers). */
  whitelist: string[];
}

/** Stable bucket 0..99 for a device. Same ID always lands in the same bucket. */
export function bucketOf(deviceId: string, salt = 'launcher-gray'): number {
  const h = createHash('sha256').update(`${salt}:${deviceId}`).digest();
  return h.readUInt32BE(0) % 100;
}

export function pickVersion(
  deviceId: string,
  stable: string,
  rule: GrayRule,
): { version: string; reason: GrayReason; bucket: number } {
  const bucket = bucketOf(deviceId);
  if (rule.whitelist.includes(deviceId)) return { version: rule.version, reason: 'whitelist', bucket };
  const pct = Math.max(0, Math.min(100, rule.percent));
  if (bucket < pct) return { version: rule.version, reason: 'bucket', bucket };
  return { version: stable, reason: 'stable', bucket };
}
