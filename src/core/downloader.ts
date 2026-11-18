import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileEntry } from '../shared/types';
import type { CdnPool } from './cdn-pool';
import { rangeHeader } from './chunks';
import { matchingChunks, sha256, sha256File } from './hash';
import { createLimiter } from './limiter';

/**
 * Chunked, resumable, verified downloader.
 *
 * Layout inside `stagingDir`:
 *   state.json            which chunks of which file are already on disk and verified
 *   files/<path>.part     pre-allocated temp files, chunks written at their offsets
 *
 * Nothing in the real game folder is touched here; the installer moves verified parts
 * into place only after every file passed its whole-file SHA-256 check.
 */

export interface DownloadState {
  targetVersion: string;
  files: Record<string, number[]>;
}

export interface DownloadProgress {
  totalBytes: number;
  doneBytes: number;
  networkBytes: number;
  resumedBytes: number;
  reusedBytes: number;
  chunksDone: number;
  chunksTotal: number;
  chunksFetched: number;
  chunksRetried: number;
  speedBps: number;
}

export interface DownloadOptions {
  targetVersion: string;
  files: FileEntry[];
  stagingDir: string;
  /** Existing install folder: chunks whose hash still matches are copied instead of downloaded. */
  seedDir?: string;
  pool: CdnPool;
  concurrency?: number;
  chunkTimeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  fetchImpl?: typeof fetch;
}

export class ChunkHashError extends Error {}

export const partPath = (stagingDir: string, rel: string) => join(stagingDir, 'files', `${rel}.part`);
const statePath = (stagingDir: string) => join(stagingDir, 'state.json');

export async function readDownloadState(stagingDir: string): Promise<DownloadState | null> {
  try {
    const s = JSON.parse(await readFile(statePath(stagingDir), 'utf8')) as DownloadState;
    if (typeof s?.targetVersion !== 'string' || typeof s.files !== 'object') return null;
    return s;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Serialises state writes and coalesces bursts; every write is tmp + rename (atomic). */
function createStateSaver(stagingDir: string, get: () => DownloadState) {
  let running: Promise<void> | null = null;
  let again = false;
  const write = async () => {
    const tmp = `${statePath(stagingDir)}.tmp`;
    await writeFile(tmp, JSON.stringify(get()));
    await rename(tmp, statePath(stagingDir));
  };
  const save = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await write();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return save;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

function abortError(): Error {
  const e = new Error('download aborted');
  e.name = 'AbortError';
  return e;
}

export async function runDownload(o: DownloadOptions): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const concurrency = o.concurrency ?? 4;
  const chunkTimeoutMs = o.chunkTimeoutMs ?? 5000;
  const maxAttempts = o.maxAttempts ?? 8;
  const log = o.onLog ?? (() => {});

  await mkdir(join(o.stagingDir, 'files'), { recursive: true });
  let state = await readDownloadState(o.stagingDir);
  if (state && state.targetVersion !== o.targetVersion) {
    log('info', `丢弃旧的未完成下载（目标 ${state.targetVersion}，现在要下 ${o.targetVersion}）`);
    await rm(o.stagingDir, { recursive: true, force: true });
    await mkdir(join(o.stagingDir, 'files'), { recursive: true });
    state = null;
  }
  const st: DownloadState = state ?? { targetVersion: o.targetVersion, files: {} };
  const saveState = createStateSaver(o.stagingDir, () => st);

  const p: DownloadProgress = {
    totalBytes: o.files.reduce((n, f) => n + f.size, 0),
    doneBytes: 0,
    networkBytes: 0,
    resumedBytes: 0,
    reusedBytes: 0,
    chunksDone: 0,
    chunksTotal: o.files.reduce((n, f) => n + f.chunks.length, 0),
    chunksFetched: 0,
    chunksRetried: 0,
    speedBps: 0,
  };
  let inflight = 0;
  const samples: Array<[number, number]> = [];
  const emit = (final = false) => {
    const now = Date.now();
    while (samples.length && now - samples[0][0] > 2000) samples.shift();
    const bytes = samples.reduce((n, s) => n + s[1], 0);
    p.speedBps = final || !samples.length ? 0 : Math.round((bytes / 2000) * 1000);
    o.onProgress?.({ ...p, doneBytes: p.doneBytes + inflight });
  };

  const done = new Map<string, Set<number>>();
  const handles = new Map<string, FileHandle>();

  try {
    // 1. Prepare: resume from state, or pre-allocate and seed from the existing install.
    let resumedChunks = 0;
    for (const f of o.files) {
      const part = partPath(o.stagingDir, f.path);
      await mkdir(dirname(part), { recursive: true });
      const prev = st.files[f.path];
      let set = new Set<number>();
      if (prev && (await exists(part)) && (await stat(part)).size === f.size) {
        set = new Set(prev.filter((i) => Number.isInteger(i) && i >= 0 && i < f.chunks.length));
        for (const i of set) p.resumedBytes += f.chunks[i].size;
        resumedChunks += set.size;
        handles.set(f.path, await open(part, 'r+'));
      } else {
        const fh = await open(part, 'w+');
        await fh.truncate(f.size);
        handles.set(f.path, fh);
        const seed = o.seedDir ? join(o.seedDir, f.path) : null;
        if (seed && (await exists(seed))) {
          const good = await matchingChunks(seed, f.chunks);
          if (good.length) {
            const src = await open(seed, 'r');
            try {
              for (const i of good) {
                const c = f.chunks[i];
                const buf = Buffer.alloc(c.size);
                await src.read(buf, 0, c.size, c.offset);
                await fh.write(buf, 0, c.size, c.offset);
                set.add(i);
                p.reusedBytes += c.size;
              }
            } finally {
              await src.close();
            }
            log('info', `${f.path}: 本地已有 ${good.length}/${f.chunks.length} 块哈希一致，直接复用`);
          }
        }
      }
      done.set(f.path, set);
      st.files[f.path] = [...set];
      p.chunksDone += set.size;
    }
    p.doneBytes = p.resumedBytes + p.reusedBytes;
    if (resumedChunks) log('info', `断点续传：跳过已完成的 ${resumedChunks}/${p.chunksTotal} 块（${(p.resumedBytes / 1048576).toFixed(1)} MB）`);
    await saveState();
    emit();

    // 2. Fetch every missing chunk with limited concurrency; verify each chunk before writing.
    const limiter = createLimiter(concurrency);

    const fetchChunk = async (f: FileEntry, idx: number) => {
      const c = f.chunks[idx];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (o.signal?.aborted) throw abortError();
        const src = o.pool.current();
        const signal = o.signal
          ? AbortSignal.any([o.signal, AbortSignal.timeout(chunkTimeoutMs)])
          : AbortSignal.timeout(chunkTimeoutMs);
        let got = 0;
        try {
          const res = await fetchImpl(`${src.url}/blobs/${f.sha256}`, {
            headers: { Range: rangeHeader({ start: c.offset, end: c.offset + c.size - 1 }) },
            signal,
          });
          if (res.status !== 206) {
            await res.body?.cancel().catch(() => {});
            throw new Error(`HTTP ${res.status}`);
          }
          const parts: Uint8Array[] = [];
          const reader = res.body!.getReader();
          for (;;) {
            const { done: end, value } = await reader.read();
            if (end) break;
            parts.push(value);
            got += value.length;
            inflight += value.length;
            p.networkBytes += value.length;
            samples.push([Date.now(), value.length]);
            emit();
          }
          const buf = Buffer.concat(parts);
          if (buf.length !== c.size) throw new Error(`short read ${buf.length}/${c.size}`);
          if (sha256(buf) !== c.sha256) throw new ChunkHashError('sha256 mismatch');
          await handles.get(f.path)!.write(buf, 0, buf.length, c.offset);
          inflight -= got;
          done.get(f.path)!.add(idx);
          st.files[f.path] = [...done.get(f.path)!];
          p.chunksDone++;
          p.chunksFetched++;
          p.doneBytes += c.size;
          o.pool.reportSuccess(src.id);
          await saveState();
          emit();
          return;
        } catch (err) {
          inflight -= got;
          if (o.signal?.aborted) throw abortError();
          const reason =
            err instanceof ChunkHashError
              ? '哈希不一致'
              : (err as Error).name === 'TimeoutError'
                ? '超时'
                : (err as Error).message;
          p.chunksRetried++;
          log('warn', `${src.name} 块 ${f.path}#${idx} 失败（${reason}），第 ${attempt} 次，准备重下`);
          o.pool.reportFailure(src.id, reason);
          emit();
          await sleep(Math.min(150 * attempt, 1000), o.signal);
        }
      }
      throw new Error(`块 ${f.path}#${idx} 重试 ${maxAttempts} 次仍失败`);
    };

    let pending = o.files;
    for (let round = 1; round <= 3 && pending.length; round++) {
      const jobs: Promise<void>[] = [];
      for (const f of pending) {
        const set = done.get(f.path)!;
        f.chunks.forEach((_, i) => {
          if (!set.has(i)) jobs.push(limiter.run(() => fetchChunk(f, i)));
        });
      }
      const results = await Promise.allSettled(jobs);
      if (o.signal?.aborted) throw abortError();
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;

      // 3. Whole-file check. A mismatch here means something on disk is wrong: re-hash
      //    chunk by chunk and only re-fetch the bad ones.
      const bad: FileEntry[] = [];
      for (const f of pending) {
        await handles.get(f.path)!.sync();
        const h = await sha256File(partPath(o.stagingDir, f.path));
        if (h === f.sha256) continue;
        const good = new Set(await matchingChunks(partPath(o.stagingDir, f.path), f.chunks));
        const lost = f.chunks.filter((_, i) => !good.has(i));
        log('warn', `${f.path} 整文件哈希不一致，${lost.length} 块需要重下`);
        p.chunksDone -= done.get(f.path)!.size - good.size;
        p.doneBytes -= lost.reduce((n, c) => n + c.size, 0);
        done.set(f.path, good);
        st.files[f.path] = [...good];
        bad.push(f);
      }
      await saveState();
      pending = bad;
    }
    if (pending.length) throw new Error(`${pending.map((f) => f.path).join(', ')} 校验始终不通过`);
    emit(true);
  } finally {
    await Promise.all([...handles.values()].map((h) => h.close().catch(() => {})));
  }
}
