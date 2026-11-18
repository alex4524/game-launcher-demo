import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileEntry, Manifest } from '../shared/types';
import { sha256File } from './hash';
import { isSafeRelativePath, validateManifest } from './manifest';
import { partPath } from './downloader';

/**
 * Game folder layout:
 *   <installDir>/<game files>
 *   <installDir>/.launcher/installed.json   manifest of what is installed
 *   <installDir>/.launcher/staging/         downloader temp area (see downloader.ts)
 */
export const metaDir = (installDir: string) => join(installDir, '.launcher');
export const stagingDir = (installDir: string) => join(metaDir(installDir), 'staging');
const installedPath = (installDir: string) => join(metaDir(installDir), 'installed.json');

export async function readInstalled(installDir: string): Promise<Manifest | null> {
  try {
    return validateManifest(JSON.parse(await readFile(installedPath(installDir), 'utf8')));
  } catch {
    return null;
  }
}

async function writeInstalled(installDir: string, m: Manifest): Promise<void> {
  await mkdir(metaDir(installDir), { recursive: true });
  const tmp = `${installedPath(installDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(m, null, 2));
  await rename(tmp, installedPath(installDir));
}

/**
 * Move verified parts into the game folder, delete files the new version dropped, then
 * record the new manifest. Called only after runDownload() resolved, i.e. every part
 * already passed its SHA-256 check.
 */
export async function applyStaged(
  installDir: string,
  downloaded: FileEntry[],
  remove: string[],
  next: Manifest | null,
): Promise<void> {
  const staging = stagingDir(installDir);
  for (const f of downloaded) {
    if (!isSafeRelativePath(f.path)) throw new Error(`unsafe path ${f.path}`);
    const dest = join(installDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await rename(partPath(staging, f.path), dest);
  }
  for (const rel of remove) {
    if (!isSafeRelativePath(rel)) continue;
    await rm(join(installDir, rel), { force: true });
  }
  if (next) await writeInstalled(installDir, next);
  await rm(staging, { recursive: true, force: true });
}

export interface ScanResult {
  bad: FileEntry[];
  checked: number;
  missing: string[];
}

/** Re-hash every installed file against the manifest (used by "repair"). */
export async function scanInstall(
  installDir: string,
  m: Manifest,
  onBytes?: (n: number) => void,
): Promise<ScanResult> {
  const bad: FileEntry[] = [];
  const missing: string[] = [];
  for (const f of m.files) {
    const file = join(installDir, f.path);
    let size = -1;
    try {
      size = (await stat(file)).size;
    } catch {
      missing.push(f.path);
      bad.push(f);
      continue;
    }
    if (size !== f.size) {
      bad.push(f);
      onBytes?.(f.size);
      continue;
    }
    if ((await sha256File(file, onBytes)) !== f.sha256) bad.push(f);
  }
  return { bad, checked: m.files.length, missing };
}
