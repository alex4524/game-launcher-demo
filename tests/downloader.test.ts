import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CdnPool } from '../src/core/cdn-pool';
import { parseRangeHeader } from '../src/core/chunks';
import { partPath, readDownloadState, runDownload } from '../src/core/downloader';
import { sha256 } from '../src/core/hash';
import { applyStaged, readInstalled, scanInstall, stagingDir } from '../src/core/installer';
import { buildFileEntry, diffManifests } from '../src/core/manifest';
import type { Manifest } from '../src/shared/types';

const CS = 64 * 1024;

interface FakeCdn {
  server: Server;
  url: string;
  mode: 'ok' | 'error' | 'hang';
  corruptOnce: Set<string>; // "<sha>:<start>" to corrupt one time
  rangeRequests: string[];
  delayMs: number;
}

const blobs = new Map<string, Buffer>();

async function startCdn(): Promise<FakeCdn> {
  const cdn: FakeCdn = { server: null as unknown as Server, url: '', mode: 'ok', corruptOnce: new Set(), rangeRequests: [], delayMs: 0 };
  cdn.server = createServer(async (req, res) => {
    if (cdn.mode === 'hang') return; // never answers
    if (cdn.mode === 'error') {
      res.writeHead(503);
      return res.end();
    }
    const sha = req.url!.split('/').pop()!;
    const blob = blobs.get(sha);
    if (!blob) {
      res.writeHead(404);
      return res.end();
    }
    const r = parseRangeHeader(req.headers.range, blob.length)!;
    cdn.rangeRequests.push(`${sha}:${r.start}`);
    if (cdn.delayMs) await new Promise((x) => setTimeout(x, cdn.delayMs));
    let body = Buffer.from(blob.subarray(r.start, r.end + 1));
    const key = `${sha}:${r.start}`;
    if (cdn.corruptOnce.has(key)) {
      cdn.corruptOnce.delete(key);
      body[0] ^= 0xff;
    }
    res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${r.start}-${r.end}/${blob.length}` });
    res.end(body);
  });
  await new Promise<void>((ok) => cdn.server.listen(0, '127.0.0.1', ok));
  const addr = cdn.server.address() as { port: number };
  cdn.url = `http://127.0.0.1:${addr.port}`;
  return cdn;
}

function makeManifest(version: string, files: Record<string, Buffer>): Manifest {
  for (const b of Object.values(files)) blobs.set(sha256(b), b);
  return { version, chunkSize: CS, files: Object.entries(files).map(([p, d]) => buildFileEntry(p, d, CS)) };
}

let a: FakeCdn;
let b: FakeCdn;
let dir: string;

beforeAll(async () => {
  a = await startCdn();
  b = await startCdn();
});
afterAll(async () => {
  a.server.closeAllConnections();
  b.server.closeAllConnections();
  await Promise.all([a, b].map((c) => new Promise((ok) => c.server.close(ok))));
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'launcher-test-'));
  for (const c of [a, b]) {
    c.mode = 'ok';
    c.corruptOnce.clear();
    c.rangeRequests = [];
    c.delayMs = 0;
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pool = () => new CdnPool([{ id: 'a', name: 'A', url: a.url }, { id: 'b', name: 'B', url: b.url }], { maxFailures: 2, cooldownMs: 60_000 });

describe('runDownload', () => {
  it('downloads every chunk with Range requests and verifies the whole file', async () => {
    const data = randomBytes(5 * CS + 100);
    const m = makeManifest('1', { 'data/x.pak': data });
    const staging = stagingDir(dir);
    await runDownload({ targetVersion: '1', files: m.files, stagingDir: staging, pool: pool() });
    expect(await readFile(partPath(staging, 'data/x.pak'))).toEqual(data);
    expect(a.rangeRequests).toHaveLength(6);
  });

  it('re-fetches a chunk whose SHA-256 does not match', async () => {
    const data = randomBytes(4 * CS);
    const m = makeManifest('1', { 'x.pak': data });
    a.corruptOnce.add(`${m.files[0].sha256}:${2 * CS}`);
    const logs: string[] = [];
    let retried = 0;
    await runDownload({
      targetVersion: '1', files: m.files, stagingDir: stagingDir(dir), pool: pool(),
      onLog: (_l, msg) => logs.push(msg), onProgress: (p) => (retried = p.chunksRetried),
    });
    expect(await readFile(partPath(stagingDir(dir), 'x.pak'))).toEqual(data);
    expect(retried).toBe(1);
    expect(logs.some((l) => l.includes('哈希不一致'))).toBe(true);
    expect(a.rangeRequests.filter((r) => r.endsWith(`:${2 * CS}`))).toHaveLength(2);
  });

  it('resumes from state.json and only fetches missing chunks', async () => {
    const data = randomBytes(8 * CS);
    const m = makeManifest('1', { 'x.pak': data });
    const staging = stagingDir(dir);
    // First run: abort after a few chunks.
    const ctrl = new AbortController();
    a.delayMs = 30;
    let done = 0;
    await expect(
      runDownload({
        targetVersion: '1', files: m.files, stagingDir: staging, pool: pool(), concurrency: 1, signal: ctrl.signal,
        onProgress: (p) => {
          done = p.chunksDone;
          if (p.chunksDone >= 3) ctrl.abort();
        },
      }),
    ).rejects.toThrow(/aborted/);
    const st = await readDownloadState(staging);
    expect(st?.files['x.pak'].length).toBeGreaterThanOrEqual(3);
    const already = st!.files['x.pak'].length;
    expect(done).toBe(already);

    // Second run: only the remaining chunks go over the network.
    a.rangeRequests = [];
    a.delayMs = 0;
    let resumed = 0;
    await runDownload({ targetVersion: '1', files: m.files, stagingDir: staging, pool: pool(), onProgress: (p) => (resumed = p.resumedBytes) });
    expect(a.rangeRequests).toHaveLength(8 - already);
    expect(resumed).toBe(already * CS);
    expect(await readFile(partPath(staging, 'x.pak'))).toEqual(data);
  });

  it('switches to the second CDN when the first keeps failing', async () => {
    const data = randomBytes(4 * CS);
    const m = makeManifest('1', { 'x.pak': data });
    a.mode = 'error';
    const p = pool();
    await runDownload({ targetVersion: '1', files: m.files, stagingDir: stagingDir(dir), pool: p, concurrency: 1 });
    expect(p.current().id).toBe('b');
    expect(b.rangeRequests).toHaveLength(4);
    expect(await readFile(partPath(stagingDir(dir), 'x.pak'))).toEqual(data);
  });

  it('treats a hanging CDN as failed after the chunk timeout', async () => {
    const data = randomBytes(2 * CS);
    const m = makeManifest('1', { 'x.pak': data });
    a.mode = 'hang';
    const p = pool();
    await runDownload({ targetVersion: '1', files: m.files, stagingDir: stagingDir(dir), pool: p, chunkTimeoutMs: 300, concurrency: 2 });
    expect(p.current().id).toBe('b');
  });
});

describe('update and repair', () => {
  it('v1 -> v2 only moves changed files, reuses unchanged chunks and deletes dropped files', async () => {
    const big = randomBytes(6 * CS);
    const big2 = Buffer.from(big);
    randomBytes(CS).copy(big2, 2 * CS); // one chunk changed
    const v1 = makeManifest('1.0.0', { 'game.js': Buffer.from('v1'), 'core.pak': big, 'same.pak': Buffer.from('same'), 'old.pak': Buffer.from('old') });
    const v2 = makeManifest('2.0.0', { 'game.js': Buffer.from('v2'), 'core.pak': big2, 'same.pak': Buffer.from('same'), 'new.pak': Buffer.from('new') });

    const p = pool();
    const plan1 = diffManifests(null, v1);
    await runDownload({ targetVersion: '1.0.0', files: plan1.download, stagingDir: stagingDir(dir), seedDir: dir, pool: p });
    await applyStaged(dir, plan1.download, plan1.remove, v1);
    expect((await readInstalled(dir))?.version).toBe('1.0.0');

    a.rangeRequests = [];
    const plan2 = diffManifests(v1, v2);
    expect(plan2.download.map((f) => f.path).sort()).toEqual(['core.pak', 'game.js', 'new.pak']);
    let reused = 0;
    await runDownload({ targetVersion: '2.0.0', files: plan2.download, stagingDir: stagingDir(dir), seedDir: dir, pool: p, onProgress: (x) => (reused = x.reusedBytes) });
    await applyStaged(dir, plan2.download, plan2.remove, v2);

    expect(await readFile(join(dir, 'core.pak'))).toEqual(big2);
    expect(await readFile(join(dir, 'game.js'), 'utf8')).toBe('v2');
    await expect(readFile(join(dir, 'old.pak'))).rejects.toThrow();
    // core.pak: 5 of 6 chunks reused from the v1 file, only 1 fetched. Plus game.js and new.pak.
    expect(reused).toBe(5 * CS);
    expect(a.rangeRequests.filter((r) => r.startsWith(v2.files[1].sha256))).toHaveLength(1);
    expect(a.rangeRequests.some((r) => r.startsWith(sha256(Buffer.from('same'))))).toBe(false);
  });

  it('repair finds a corrupted file and re-fetches only the bad chunk', async () => {
    const data = randomBytes(4 * CS);
    const m = makeManifest('1.0.0', { 'core.pak': data, 'ok.pak': Buffer.from('fine') });
    const p = pool();
    const plan = diffManifests(null, m);
    await runDownload({ targetVersion: '1.0.0', files: plan.download, stagingDir: stagingDir(dir), seedDir: dir, pool: p });
    await applyStaged(dir, plan.download, [], m);

    const broken = Buffer.from(data);
    broken[3 * CS + 7] ^= 0xff;
    await writeFile(join(dir, 'core.pak'), broken);

    const scan = await scanInstall(dir, m);
    expect(scan.bad.map((f) => f.path)).toEqual(['core.pak']);

    a.rangeRequests = [];
    await runDownload({ targetVersion: '1.0.0+repair', files: scan.bad, stagingDir: stagingDir(dir), seedDir: dir, pool: p });
    await applyStaged(dir, scan.bad, [], null);
    expect(a.rangeRequests).toEqual([`${m.files[0].sha256}:${3 * CS}`]);
    expect(await readFile(join(dir, 'core.pak'))).toEqual(data);
    expect((await scanInstall(dir, m)).bad).toEqual([]);
  });

  it('a missing file counts as broken', async () => {
    const m = makeManifest('1.0.0', { 'a.pak': Buffer.from('a') });
    await mkdir(dir, { recursive: true });
    expect((await scanInstall(dir, m)).missing).toEqual(['a.pak']);
  });
});
