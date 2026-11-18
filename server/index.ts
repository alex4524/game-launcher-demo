/**
 * Fake backend for the launcher demo. Everything binds to 127.0.0.1 only.
 *
 *   :7300  version service  /api/config  /api/version?deviceId=  /updates/latest-mac.yml  /admin/*
 *   :7301  CDN-A            /ping  /blobs/<sha256>  (HTTP Range)
 *   :7302  CDN-B            same as CDN-A
 *
 * Fault injection (POST JSON to :7300):
 *   /admin/cdn/cdn-a   {"mode":"ok"|"error"|"timeout"|"corrupt","latencyMs":0,"rateKBps":1024,"corruptCount":3}
 *   /admin/gray        {"percent":20,"whitelist":["<deviceId>"]}
 *   /admin/self-update {"version":"1.1.0"}
 *   /admin/reset-stats
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseRangeHeader } from '../src/core/chunks';
import { pickVersion, type GrayRule } from '../src/core/gray';
import type { CdnSource, VersionResponse } from '../src/shared/types';
import { loadData, NEXT, STABLE } from './data';

const HOST = '127.0.0.1';
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : (process.env[`DEMO_${name.toUpperCase()}`] ?? def);
};
const DATA_DIR = resolve(arg('data', '.demo-data'));
const CONTROL_PORT = Number(arg('port', '7300'));
const DEFAULT_RATE = Number(arg('rate', '1024'));

type Mode = 'ok' | 'error' | 'timeout' | 'corrupt';
interface CdnRuntime {
  src: CdnSource;
  port: number;
  mode: Mode;
  latencyMs: number;
  rateKBps: number;
  corruptCount: number;
  bytesServed: number;
  requests: number;
  errors: number;
}

const cdns: CdnRuntime[] = [
  { id: 'cdn-a', name: 'CDN-A', port: CONTROL_PORT + 1, latency: 0 },
  { id: 'cdn-b', name: 'CDN-B', port: CONTROL_PORT + 2, latency: 60 },
].map((c) => ({
  src: { id: c.id, name: c.name, url: `http://${HOST}:${c.port}` },
  port: c.port,
  mode: 'ok' as Mode,
  latencyMs: c.latency,
  rateKBps: DEFAULT_RATE,
  corruptCount: 0,
  bytesServed: 0,
  requests: 0,
  errors: 0,
}));

const gray: GrayRule = { version: NEXT, percent: 0, whitelist: [] };
let selfUpdateVersion = '1.1.0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a: unknown[]) => console.log(ts(), ...a);

function json(res: ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const data = await loadData(DATA_DIR);
  log(`data ready in ${DATA_DIR}: versions ${Object.keys(data.manifests).join(', ')}, ${data.blobs.size} blobs`);

  // ---------- CDN servers ----------
  for (const cdn of cdns) {
    const server = createServer(async (req, res) => {
      cdn.requests++;
      if (cdn.latencyMs) await sleep(cdn.latencyMs);
      if (cdn.mode === 'timeout') {
        // Hang until the client gives up.
        cdn.errors++;
        req.on('close', () => res.destroy());
        return;
      }
      if (cdn.mode === 'error') {
        cdn.errors++;
        return json(res, 503, { error: 'injected failure' });
      }
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/ping') return json(res, 200, { ok: true, cdn: cdn.src.id });
      const m = /^\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
      const blob = m && data.blobs.get(m[1]);
      if (!blob) return json(res, 404, { error: 'not found' });
      const range = parseRangeHeader(req.headers.range, blob.size);
      if (!range) {
        res.writeHead(416, { 'content-range': `bytes */${blob.size}` });
        return res.end();
      }
      const len = range.end - range.start + 1;
      const buf = Buffer.alloc(len);
      const fh = await open(blob.file, 'r');
      try {
        await fh.read(buf, 0, len, range.start);
      } finally {
        await fh.close();
      }
      if (cdn.mode === 'corrupt' && cdn.corruptCount > 0) {
        cdn.corruptCount--;
        buf[Math.floor(len / 2)] ^= 0xff;
        log(`${cdn.src.name} corrupted a response (${cdn.corruptCount} left)`);
        if (cdn.corruptCount === 0) cdn.mode = 'ok';
      }
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': len,
        'content-range': `bytes ${range.start}-${range.end}/${blob.size}`,
        'accept-ranges': 'bytes',
      });
      // Throttle per connection so a download takes long enough to interrupt.
      const piece = 64 * 1024;
      const delay = (piece / (cdn.rateKBps * 1024)) * 1000;
      let closed = false;
      res.on('close', () => (closed = true));
      for (let off = 0; off < len && !closed; off += piece) {
        // The mode can be flipped by /admin while this response is streaming.
        const live = cdn.mode as Mode;
        if (live === 'timeout' || live === 'error') {
          res.destroy();
          return;
        }
        const part = buf.subarray(off, Math.min(off + piece, len));
        res.write(part);
        cdn.bytesServed += part.length;
        if (delay > 0) await sleep(delay);
      }
      res.end();
    });
    await new Promise<void>((r) => server.listen(cdn.port, HOST, r));
    log(`${cdn.src.name} listening on ${cdn.src.url}`);
  }

  // ---------- version service + admin ----------
  const control = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/config') {
        return json(res, 200, { cdns: cdns.map((c) => c.src) });
      }
      if (req.method === 'GET' && p === '/api/version') {
        const deviceId = url.searchParams.get('deviceId') ?? '';
        if (!/^[\w-]{8,64}$/.test(deviceId)) return json(res, 400, { error: 'bad deviceId' });
        const pick = pickVersion(deviceId, STABLE, gray);
        const body: VersionResponse = { ...pick, manifest: data.manifests[pick.version] };
        log(`version for ${deviceId.slice(0, 8)}… -> ${pick.version} (${pick.reason}, bucket ${pick.bucket})`);
        return json(res, 200, body);
      }
      if (req.method === 'GET' && p === '/updates/latest-mac.yml') {
        const file = `Game-Launcher-Demo-${selfUpdateVersion}-arm64-mac.zip`;
        const fakeSha512 = Buffer.alloc(64).toString('base64');
        res.writeHead(200, { 'content-type': 'text/yaml', 'cache-control': 'no-store' });
        return res.end(
          `version: ${selfUpdateVersion}\nfiles:\n  - url: ${file}\n    sha512: ${fakeSha512}\n    size: 1\npath: ${file}\nsha512: ${fakeSha512}\nreleaseDate: '2026-11-19T00:00:00.000Z'\n`,
        );
      }
      if (req.method === 'GET' && p === '/admin/state') {
        return json(res, 200, {
          gray,
          stable: STABLE,
          selfUpdateVersion,
          cdns: cdns.map(({ src, mode, latencyMs, rateKBps, corruptCount, bytesServed, requests, errors }) => ({
            ...src, mode, latencyMs, rateKBps, corruptCount, bytesServed, requests, errors,
          })),
        });
      }
      if (req.method === 'POST' && p.startsWith('/admin/cdn/')) {
        const cdn = cdns.find((c) => c.src.id === p.slice('/admin/cdn/'.length));
        if (!cdn) return json(res, 404, { error: 'no such cdn' });
        const b = await readBody(req);
        if (b.mode && ['ok', 'error', 'timeout', 'corrupt'].includes(b.mode as string)) cdn.mode = b.mode as Mode;
        if (typeof b.latencyMs === 'number') cdn.latencyMs = b.latencyMs;
        if (typeof b.rateKBps === 'number' && b.rateKBps > 0) cdn.rateKBps = b.rateKBps;
        if (typeof b.corruptCount === 'number') cdn.corruptCount = b.corruptCount;
        log(`admin: ${cdn.src.name} -> mode=${cdn.mode} latency=${cdn.latencyMs} rate=${cdn.rateKBps}KB/s corrupt=${cdn.corruptCount}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/admin/gray') {
        const b = await readBody(req);
        if (typeof b.percent === 'number') gray.percent = b.percent;
        if (Array.isArray(b.whitelist)) gray.whitelist = b.whitelist.map(String);
        log(`admin: gray -> ${gray.version} percent=${gray.percent} whitelist=${gray.whitelist.length}`);
        return json(res, 200, { ok: true, gray });
      }
      if (req.method === 'POST' && p === '/admin/self-update') {
        const b = await readBody(req);
        if (typeof b.version === 'string' && /^\d+\.\d+\.\d+$/.test(b.version)) selfUpdateVersion = b.version;
        return json(res, 200, { ok: true, selfUpdateVersion });
      }
      if (req.method === 'POST' && p === '/admin/reset-stats') {
        for (const c of cdns) Object.assign(c, { bytesServed: 0, requests: 0, errors: 0 });
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => control.listen(CONTROL_PORT, HOST, r));
  log(`version service listening on http://${HOST}:${CONTROL_PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
