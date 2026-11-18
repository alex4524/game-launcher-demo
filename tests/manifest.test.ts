import { describe, expect, it } from 'vitest';
import { buildFileEntry, diffManifests, isSafeRelativePath, validateManifest } from '../src/core/manifest';
import type { Manifest } from '../src/shared/types';

const CS = 1024;
const m = (version: string, files: Record<string, string>): Manifest => ({
  version,
  chunkSize: CS,
  files: Object.entries(files).map(([p, c]) => buildFileEntry(p, Buffer.from(c), CS)),
});

describe('diffManifests', () => {
  const v1 = m('1.0.0', { 'game.js': 'v1', 'data/a.pak': 'AAAA', 'data/old.pak': 'OLD' });
  const v2 = m('2.0.0', { 'game.js': 'v2', 'data/a.pak': 'AAAA', 'data/new.pak': 'NEW' });

  it('fresh install downloads everything', () => {
    const p = diffManifests(null, v1);
    expect(p.download.map((f) => f.path).sort()).toEqual(['data/a.pak', 'data/old.pak', 'game.js']);
    expect(p.remove).toEqual([]);
    expect(p.downloadBytes).toBe(2 + 4 + 3);
  });

  it('update: only changed + new files, removes dropped files, skips identical ones', () => {
    const p = diffManifests(v1, v2);
    expect(p.download.map((f) => f.path).sort()).toEqual(['data/new.pak', 'game.js']);
    expect(p.same.map((f) => f.path)).toEqual(['data/a.pak']);
    expect(p.remove).toEqual(['data/old.pak']);
  });

  it('same version: nothing to do', () => {
    const p = diffManifests(v2, v2);
    expect(p.download).toEqual([]);
    expect(p.remove).toEqual([]);
  });
});

describe('manifest validation (remote input is untrusted)', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validateManifest(m('1.0.0', { 'a/b.pak': 'x'.repeat(3000) }))).not.toThrow();
  });
  it.each(['../evil', '/etc/passwd', 'a/../../b', 'C:/win', 'a\\b', '.launcher/installed.json', 'a//b', ''])(
    'rejects unsafe path %s',
    (p) => {
      expect(isSafeRelativePath(p)).toBe(false);
      const bad = m('1.0.0', { ok: '1' });
      bad.files[0].path = p;
      expect(() => validateManifest(bad)).toThrow(/invalid manifest/);
    },
  );
  it('rejects inconsistent chunk lists', () => {
    const bad = m('1.0.0', { 'a.pak': 'x'.repeat(3000) });
    bad.files[0].chunks.pop();
    expect(() => validateManifest(bad)).toThrow(/chunk count/);
  });
  it('rejects bad hashes and versions', () => {
    const bad = m('1.0.0', { 'a.pak': 'x' });
    bad.files[0].sha256 = 'nothex';
    expect(() => validateManifest(bad)).toThrow(/sha256/);
    expect(() => validateManifest({ ...m('1', {}), version: '1; rm -rf' })).toThrow(/version/);
  });
});
