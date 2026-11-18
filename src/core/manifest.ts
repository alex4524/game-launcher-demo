import type { FileEntry, Manifest } from '../shared/types';
import { splitRanges } from './chunks';
import { sha256 } from './hash';

export function buildFileEntry(path: string, data: Uint8Array, chunkSize: number): FileEntry {
  return {
    path,
    size: data.length,
    sha256: sha256(data),
    chunks: splitRanges(data.length, chunkSize).map((r) => ({
      offset: r.start,
      size: r.end - r.start + 1,
      sha256: sha256(data.subarray(r.start, r.end + 1)),
    })),
  };
}

export interface UpdatePlan {
  /** New files and files whose content changed. */
  download: FileEntry[];
  /** Files present locally but gone from the new version. */
  remove: string[];
  /** Files identical in both versions. */
  same: FileEntry[];
  downloadBytes: number;
}

/** Compare the installed manifest with the target manifest. `local` null = fresh install. */
export function diffManifests(local: Manifest | null, remote: Manifest): UpdatePlan {
  const old = new Map((local?.files ?? []).map((f) => [f.path, f]));
  const download: FileEntry[] = [];
  const same: FileEntry[] = [];
  for (const f of remote.files) {
    const prev = old.get(f.path);
    if (prev && prev.sha256 === f.sha256 && prev.size === f.size) same.push(f);
    else download.push(f);
    old.delete(f.path);
  }
  return {
    download,
    remove: [...old.keys()],
    same,
    downloadBytes: download.reduce((n, f) => n + f.size, 0),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A relative POSIX path that cannot escape the game directory. */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 255) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('.launcher'));
}

/**
 * Remote manifests are untrusted input (a compromised CDN or config could send anything).
 * Reject anything that could write outside the game folder or that is internally inconsistent.
 */
export function validateManifest(m: unknown): Manifest {
  const fail = (why: string): never => {
    throw new Error(`invalid manifest: ${why}`);
  };
  if (!m || typeof m !== 'object') fail('not an object');
  const { version, chunkSize, files } = m as Manifest;
  if (typeof version !== 'string' || !/^[\w.-]{1,32}$/.test(version)) fail('version');
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > 64 * 1024 * 1024) fail('chunkSize');
  if (!Array.isArray(files)) fail('files');
  const seen = new Set<string>();
  for (const f of files) {
    if (!isSafeRelativePath(f?.path)) fail(`unsafe path ${String(f?.path)}`);
    if (seen.has(f.path)) fail(`duplicate path ${f.path}`);
    seen.add(f.path);
    if (!Number.isInteger(f.size) || f.size < 0) fail(`size of ${f.path}`);
    if (!HEX64.test(f.sha256)) fail(`sha256 of ${f.path}`);
    if (!Array.isArray(f.chunks)) fail(`chunks of ${f.path}`);
    const expected = splitRanges(f.size, chunkSize);
    if (expected.length !== f.chunks.length) fail(`chunk count of ${f.path}`);
    f.chunks.forEach((c, i) => {
      const e = expected[i];
      if (c.offset !== e.start || c.size !== e.end - e.start + 1 || !HEX64.test(c.sha256)) fail(`chunk ${i} of ${f.path}`);
    });
  }
  return m as Manifest;
}
