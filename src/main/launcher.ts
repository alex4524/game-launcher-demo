import type { ChildProcess } from 'node:child_process';
import type {
  LauncherState,
  LogLine,
  Manifest,
  RemoteConfig,
  TaskKind,
  TaskProgress,
  VersionResponse,
} from '../shared/types';
import { CdnPool, probeLatency } from '../core/cdn-pool';
import { readDownloadState, runDownload, type DownloadProgress } from '../core/downloader';
import { applyStaged, readInstalled, scanInstall, stagingDir } from '../core/installer';
import { diffManifests, validateManifest } from '../core/manifest';
import { throttle } from '../core/throttle';
import { spawnGame } from './game';
import type { SettingsStore } from './settings';

export interface LauncherHooks {
  push(state: LauncherState): void;
  writeLog(line: string): void;
  loginItem: { get(): { openAtLogin: boolean; status: string }; set(v: boolean): void };
}

const MB = 1048576;
const fmtMB = (n: number) => `${(n / MB).toFixed(1)} MB`;
const BUSY = new Set(['checking', 'downloading', 'applying', 'repairing']);

/** All launcher business logic lives here; index.ts only wires Electron to it. */
export class Launcher {
  readonly state: LauncherState;
  private pool: CdnPool | null = null;
  private installed: Manifest | null = null;
  private remote: VersionResponse | null = null;
  private abort: AbortController | null = null;
  private game: ChildProcess | null = null;
  private readonly pushThrottled: ReturnType<typeof throttle<[]>>;

  constructor(
    private readonly installDir: string,
    private readonly serverUrl: string,
    appVersion: string,
    private readonly settings: SettingsStore,
    private readonly hooks: LauncherHooks,
  ) {
    const li = hooks.loginItem.get();
    this.state = {
      appVersion,
      deviceId: settings.data.deviceId,
      installDir,
      installedVersion: null,
      remote: null,
      plan: null,
      pendingResume: null,
      phase: 'idle',
      task: null,
      lastResult: null,
      cdns: [],
      game: { running: false, pid: null, lastExitCode: null, log: [] },
      settings: { openAtLogin: li.openAtLogin, loginItemStatus: li.status },
      selfUpdate: { status: 'idle' },
      window: { visible: true, tray: false },
      error: null,
      logs: [],
    };
    // Progress events can fire thousands of times per second; the UI gets at most ~6/s.
    this.pushThrottled = throttle(() => this.hooks.push(structuredClone(this.state)), 150);
  }

  emit(): void {
    if (this.pool) this.state.cdns = this.pool.view();
    this.pushThrottled();
  }

  log(level: LogLine['level'], msg: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    this.state.logs.push({ time, level, msg });
    if (this.state.logs.length > 120) this.state.logs.splice(0, this.state.logs.length - 120);
    this.hooks.writeLog(`${new Date().toLocaleString('sv-SE')} [${level}] ${msg}`);
    this.emit();
  }

  async init(): Promise<void> {
    this.installed = await readInstalled(this.installDir);
    this.state.installedVersion = this.installed?.version ?? null;
    this.log('info', `启动。设备 ID ${this.state.deviceId}，本地版本 ${this.state.installedVersion ?? '未安装'}`);
    try {
      const cfg = (await this.getJson('/api/config')) as RemoteConfig;
      this.pool = new CdnPool(cfg.cdns, {
        remembered: this.settings.data.rememberedCdn,
        onSwitch: (from, to, reason) => {
          this.log('warn', `切换下载源：${from?.name ?? '无'} → ${to.name}（${reason}）`);
        },
        onRemember: (id) => {
          void this.settings.update({ rememberedCdn: id });
          this.log('info', `记住可用源 ${id}，下次启动优先使用`);
        },
      });
      if (this.settings.data.rememberedCdn) this.log('info', `上次可用的源：${this.settings.data.rememberedCdn}`);
      await this.retestCdn();
      await this.checkUpdate();
    } catch (e) {
      this.fail(`连不上版本服务：${(e as Error).message}`);
    }
  }

  async retestCdn(): Promise<void> {
    if (!this.pool) return;
    const results: Record<string, number | null> = {};
    await Promise.all(this.pool.sources.map(async (s) => (results[s.id] = await probeLatency(s.url))));
    this.pool.applyProbe(results);
    const desc = this.pool.view().map((c) => `${c.name} ${c.latencyMs === null ? '不可用' : `${c.latencyMs}ms`}`).join('，');
    this.log('info', `测速：${desc}；选用 ${this.pool.current().name}`);
  }

  async checkUpdate(): Promise<void> {
    if (BUSY.has(this.state.phase)) return;
    const prev = this.state.phase;
    this.state.phase = 'checking';
    this.state.error = null;
    this.emit();
    try {
      const v = (await this.getJson(`/api/version?deviceId=${encodeURIComponent(this.state.deviceId)}`)) as VersionResponse;
      v.manifest = validateManifest(v.manifest);
      this.remote = v;
      this.state.remote = { version: v.version, reason: v.reason, bucket: v.bucket };
      const plan = diffManifests(this.installed, v.manifest);
      this.state.plan = { download: plan.download.length, skip: plan.same.length, remove: plan.remove.length, bytes: plan.downloadBytes };
      const why = { whitelist: '白名单', bucket: `灰度桶 ${v.bucket}`, stable: `稳定版（桶 ${v.bucket}）` }[v.reason];
      this.log('info', `服务端给的版本 ${v.version}（${why}）。计划：下载 ${plan.download.length} 个、跳过 ${plan.same.length} 个、删除 ${plan.remove.length} 个，共 ${fmtMB(plan.downloadBytes)}`);
      await this.refreshPendingResume();
    } catch (e) {
      this.state.error = `检查更新失败：${(e as Error).message}`;
      this.log('error', this.state.error);
    } finally {
      if (prev === 'playing') this.state.phase = 'playing';
      else if (prev === 'paused' && this.state.pendingResume) this.state.phase = 'paused';
      else this.state.phase = this.state.error ? 'error' : 'idle';
      this.emit();
    }
  }

  private async refreshPendingResume(): Promise<void> {
    const st = await readDownloadState(stagingDir(this.installDir));
    if (!st || !this.remote || st.targetVersion !== this.remote.version) {
      this.state.pendingResume = null;
      return;
    }
    const files = new Map(this.remote.manifest.files.map((f) => [f.path, f]));
    let doneBytes = 0;
    for (const [path, idx] of Object.entries(st.files)) {
      const f = files.get(path);
      if (f) for (const i of idx) doneBytes += f.chunks[i]?.size ?? 0;
    }
    const plan = diffManifests(this.installed, this.remote.manifest);
    this.state.pendingResume = { targetVersion: st.targetVersion, doneBytes, totalBytes: plan.downloadBytes };
    if (doneBytes > 0) this.log('info', `发现未完成的下载：${st.targetVersion} 已完成 ${fmtMB(doneBytes)} / ${fmtMB(plan.downloadBytes)}`);
  }

  async install(): Promise<void> {
    this.assertIdle('更新');
    if (!this.remote) await this.checkUpdate();
    const remote = this.remote;
    if (!remote || !this.pool) throw new Error('没有可用的版本信息');
    const plan = diffManifests(this.installed, remote.manifest);
    if (!plan.download.length && !plan.remove.length) {
      this.state.lastResult = `已是最新版本 ${remote.version}`;
      this.log('info', this.state.lastResult);
      return;
    }
    const kind: TaskKind = this.installed ? 'update' : 'install';
    this.log('info', `${kind === 'install' ? '开始安装' : `开始增量更新 ${this.installed!.version} →`} ${remote.version}`);
    const ok = await this.download(kind, remote.version, plan.download, {
      filesSkipped: plan.same.length,
      filesRemoved: plan.remove.length,
    });
    if (!ok) return;
    this.state.phase = 'applying';
    this.emit();
    await applyStaged(this.installDir, plan.download, plan.remove, remote.manifest);
    this.installed = remote.manifest;
    this.state.installedVersion = remote.version;
    this.state.pendingResume = null;
    const t = this.state.task!;
    this.state.lastResult =
      `${kind === 'install' ? '安装' : '更新'}完成 ${remote.version}：下载 ${plan.download.length} 个文件（网络 ${fmtMB(t.networkBytes)}，` +
      `续传 ${fmtMB(t.resumedBytes)}，本地复用 ${fmtMB(t.reusedBytes)}），跳过 ${plan.same.length} 个，删除 ${plan.remove.length} 个，重下块 ${t.chunksRetried}`;
    this.log('info', this.state.lastResult);
    this.state.phase = 'idle';
    this.state.plan = { download: 0, skip: remote.manifest.files.length, remove: 0, bytes: 0 };
    this.emit();
  }

  pause(): void {
    if (this.state.phase !== 'downloading') return;
    this.abort?.abort();
  }

  async repair(): Promise<void> {
    this.assertIdle('修复');
    const m = this.installed;
    if (!m) throw new Error('还没有安装游戏');
    this.state.phase = 'repairing';
    this.state.error = null;
    const total = m.files.reduce((n, f) => n + f.size, 0);
    this.state.task = this.blankTask('repair', m.version, total);
    this.log('info', `修复：重算 ${m.files.length} 个文件的 SHA-256`);
    let hashed = 0;
    const scan = await scanInstall(this.installDir, m, (n) => {
      hashed += n;
      this.state.task!.doneBytes = hashed;
      this.emit();
    });
    if (!scan.bad.length) {
      this.state.phase = 'idle';
      this.state.lastResult = `修复：${scan.checked} 个文件全部校验通过`;
      this.log('info', this.state.lastResult);
      return;
    }
    this.log('warn', `修复：${scan.bad.length} 个文件损坏或缺失：${scan.bad.map((f) => f.path).join(', ')}`);
    this.state.phase = 'idle';
    const ok = await this.download('repair', `${m.version}+repair`, scan.bad, { filesSkipped: scan.checked - scan.bad.length, filesRemoved: 0 }, 'repairing');
    if (!ok) return;
    await applyStaged(this.installDir, scan.bad, [], null);
    const t = this.state.task!;
    this.state.lastResult = `修复完成：${scan.bad.length} 个文件，重下 ${t.chunksFetched}/${t.chunksTotal} 块（网络 ${fmtMB(t.networkBytes)}），本地复用 ${fmtMB(t.reusedBytes)}`;
    this.log('info', this.state.lastResult);
    this.state.phase = 'idle';
    this.emit();
  }

  launchGame(): void {
    if (this.game) throw new Error('游戏已经在运行');
    this.assertIdle('启动游戏');
    if (!this.installed) throw new Error('还没有安装游戏');
    if (this.state.plan && this.state.plan.download > 0) this.log('warn', '有可用更新，仍按当前版本启动');
    this.state.game.log = [];
    const child = spawnGame(this.installDir, {
      onLine: (l) => {
        this.state.game.log.push(l);
        if (this.state.game.log.length > 40) this.state.game.log.shift();
        this.emit();
      },
      onExit: (code, signal) => {
        this.game = null;
        this.state.game.running = false;
        this.state.game.pid = null;
        this.state.game.lastExitCode = code;
        this.state.phase = 'idle';
        this.log(code === 0 ? 'info' : 'warn', `游戏进程退出，退出码 ${code}${signal ? `，信号 ${signal}` : ''}`);
      },
    });
    this.game = child;
    this.state.game.running = true;
    this.state.game.pid = child.pid ?? null;
    this.state.phase = 'playing';
    this.log('info', `启动游戏 pid=${child.pid}；运行期间禁止更新和修复`);
  }

  setOpenAtLogin(v: boolean): void {
    this.hooks.loginItem.set(v);
    const li = this.hooks.loginItem.get();
    this.state.settings = { openAtLogin: li.openAtLogin, loginItemStatus: li.status };
    this.log('info', `开机启动设置为 ${v ? '开' : '关'}；系统返回 openAtLogin=${li.openAtLogin} status=${li.status}`);
  }

  setSelfUpdate(s: LauncherState['selfUpdate']): void {
    this.state.selfUpdate = s;
    this.emit();
  }

  setWindow(w: Partial<LauncherState['window']>): void {
    Object.assign(this.state.window, w);
    this.emit();
  }

  stopGame(): void {
    this.game?.kill('SIGTERM');
  }

  get isGameRunning(): boolean {
    return this.game !== null;
  }

  // ---------- helpers ----------

  private async download(
    kind: TaskKind,
    targetVersion: string,
    files: Manifest['files'],
    extra: { filesSkipped: number; filesRemoved: number },
    phase: 'downloading' | 'repairing' = 'downloading',
  ): Promise<boolean> {
    const total = files.reduce((n, f) => n + f.size, 0);
    this.state.task = { ...this.blankTask(kind, targetVersion, total), filesToDownload: files.length, ...extra };
    this.state.phase = phase === 'repairing' ? 'repairing' : 'downloading';
    this.state.error = null;
    this.abort = new AbortController();
    this.emit();
    try {
      await runDownload({
        targetVersion,
        files,
        stagingDir: stagingDir(this.installDir),
        seedDir: this.installDir,
        pool: this.pool!,
        concurrency: 4,
        chunkTimeoutMs: 4000,
        signal: this.abort.signal,
        onLog: (level, msg) => this.log(level, msg),
        onProgress: (p: DownloadProgress) => {
          Object.assign(this.state.task!, p);
          this.emit();
        },
      });
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        this.state.phase = 'paused';
        this.log('info', `已暂停，已完成 ${fmtMB(this.state.task!.doneBytes)}`);
        await this.refreshPendingResume();
      } else {
        this.fail(`下载失败：${(e as Error).message}`);
        await this.refreshPendingResume();
      }
      this.emit();
      return false;
    } finally {
      this.abort = null;
    }
  }

  private blankTask(kind: TaskKind, targetVersion: string, totalBytes: number): TaskProgress {
    return {
      kind,
      targetVersion,
      totalBytes,
      doneBytes: 0,
      networkBytes: 0,
      resumedBytes: 0,
      reusedBytes: 0,
      speedBps: 0,
      chunksDone: 0,
      chunksTotal: 0,
      chunksFetched: 0,
      chunksRetried: 0,
      filesToDownload: 0,
      filesSkipped: 0,
      filesRemoved: 0,
    };
  }

  private assertIdle(action: string): void {
    if (this.state.phase === 'playing' || this.game) {
      this.log('warn', `游戏运行中，拒绝${action}`);
      throw new Error(`游戏运行中，不能${action}`);
    }
    if (BUSY.has(this.state.phase)) throw new Error(`正在${this.state.phase}，请稍后`);
  }

  private fail(msg: string): void {
    this.state.phase = 'error';
    this.state.error = msg;
    this.log('error', msg);
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${this.serverUrl}${path}`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return res.json();
  }
}
