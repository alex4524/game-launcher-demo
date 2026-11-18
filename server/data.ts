import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../src/shared/types';
import { buildFileEntry } from '../src/core/manifest';

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const STABLE = '1.0.0';
export const NEXT = '2.0.0';
const MB = 1024 * 1024;

/** Deterministic pseudo-random bytes so every machine generates the same "game". */
function prng(seed: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  const u32 = new Uint32Array(out.buffer, out.byteOffset, Math.floor(size / 4));
  let s = seed >>> 0 || 1;
  for (let i = 0; i < u32.length; i++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    u32[i] = s;
  }
  return out;
}

function fakeGameScript(version: string): Buffer {
  return Buffer.from(`// Fake game used by the launcher demo. Runs under Node (ELECTRON_RUN_AS_NODE).
const fs = require('fs');
const path = require('path');
const VERSION = ${JSON.stringify(version)};
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
console.log('[FakeGame ' + VERSION + '] boot pid=' + process.pid + ' cwd=' + process.cwd());
for (const f of fs.readdirSync(path.join(__dirname, 'data')).sort()) {
  const size = fs.statSync(path.join(__dirname, 'data', f)).size;
  console.log('[FakeGame] load data/' + f + ' ' + (size / 1048576).toFixed(1) + ' MB');
}
let frame = 0;
const timer = setInterval(() => {
  frame += 1;
  console.log('[FakeGame] frame ' + frame * 60 + ' fps=60 map=' + cfg.map);
  if (frame >= cfg.frames) {
    clearInterval(timer);
    console.log('[FakeGame] quit, exitCode=' + cfg.exitCode);
    process.exit(cfg.exitCode);
  }
}, 500);
process.on('SIGTERM', () => { console.log('[FakeGame] SIGTERM'); process.exit(143); });
`);
}

interface Release {
  version: string;
  files: Record<string, Buffer>;
}

function releases(): Release[] {
  const core = prng(1, 24 * MB);
  const textures = prng(2, 16 * MB);
  const audio = prng(3, 12 * MB);
  const legacy = prng(4, 4 * MB);
  const voice = prng(5, 6 * MB);

  // v2 core.pak = v1 core.pak with three 1 MiB regions rewritten (a "patch").
  const core2 = Buffer.from(core);
  for (const i of [3, 4, 10]) prng(100 + i, MB).copy(core2, i * MB);

  return [
    {
      version: STABLE,
      files: {
        'game.js': fakeGameScript(STABLE),
        'config.json': Buffer.from(JSON.stringify({ map: 'tutorial', frames: 8, exitCode: 0 }, null, 2)),
        'data/core.pak': core,
        'data/textures.pak': textures,
        'data/audio.pak': audio,
        'data/legacy.pak': legacy,
      },
    },
    {
      version: NEXT,
      files: {
        'game.js': fakeGameScript(NEXT),
        'config.json': Buffer.from(JSON.stringify({ map: 'chapter-2', frames: 8, exitCode: 0 }, null, 2)),
        'data/core.pak': core2,
        'data/textures.pak': textures,
        'data/audio.pak': audio,
        'data/voice-cn.pak': voice,
      },
    },
  ];
}

export interface ServerData {
  manifests: Record<string, Manifest>;
  /** sha256 -> blob file on disk */
  blobs: Map<string, { file: string; size: number }>;
}

/** Generate (once) the two releases into `dir` and index blobs by sha256. */
export async function loadData(dir: string): Promise<ServerData> {
  const manifestFile = join(dir, 'manifests.json');
  await mkdir(join(dir, 'blobs'), { recursive: true });
  let manifests: Record<string, Manifest>;
  if (existsSync(manifestFile)) {
    manifests = JSON.parse(await readFile(manifestFile, 'utf8'));
  } else {
    manifests = {};
    for (const r of releases()) {
      const files = Object.entries(r.files).map(([path, data]) => buildFileEntry(path, data, CHUNK_SIZE));
      for (const [i, f] of files.entries()) {
        const blob = join(dir, 'blobs', f.sha256);
        if (!existsSync(blob)) await writeFile(blob, Object.values(r.files)[i]);
      }
      manifests[r.version] = { version: r.version, chunkSize: CHUNK_SIZE, files };
    }
    await writeFile(manifestFile, JSON.stringify(manifests, null, 2));
  }
  const blobs = new Map<string, { file: string; size: number }>();
  for (const m of Object.values(manifests)) {
    for (const f of m.files) blobs.set(f.sha256, { file: join(dir, 'blobs', f.sha256), size: f.size });
  }
  return { manifests, blobs };
}
