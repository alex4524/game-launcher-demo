import { useEffect, useRef, useState } from 'react';
import type { LauncherApi, LauncherState } from '../shared/types';

declare global {
  interface Window {
    launcher: LauncherApi;
  }
}

const api = window.launcher;
const MB = 1048576;
const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;
const speed = (bps: number) => (bps >= MB ? `${(bps / MB).toFixed(2)} MB/s` : `${Math.round(bps / 1024)} KB/s`);

const PHASE: Record<LauncherState['phase'], string> = {
  idle: '空闲',
  checking: '检查更新中',
  downloading: '下载中',
  paused: '已暂停',
  applying: '安装文件中',
  repairing: '修复中',
  playing: '游戏运行中',
  error: '出错',
};

const REASON: Record<string, string> = { whitelist: '白名单', bucket: '灰度命中', stable: '稳定版' };

export function App() {
  const [s, setS] = useState<LauncherState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.getState().then(setS);
    return api.onState(setS);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [s?.logs.length]);

  const run = (fn: () => Promise<unknown>) => () => {
    setToast(null);
    fn().catch((e: Error) => setToast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  };

  if (!s) return <div className="loading">加载中…</div>;

  const busy = ['checking', 'downloading', 'applying', 'repairing'].includes(s.phase);
  const playing = s.phase === 'playing';
  const hasUpdate = !!s.plan && (s.plan.download > 0 || s.plan.remove > 0);
  const resumable = !!s.pendingResume && s.pendingResume.doneBytes > 0;
  const t = s.task;
  const pct = t && t.totalBytes ? Math.min(100, (t.doneBytes / t.totalBytes) * 100) : 0;

  let primary: { label: string; onClick?: () => void; disabled?: boolean };
  if (s.phase === 'downloading') primary = { label: '暂停', onClick: run(api.pause) };
  else if (playing) primary = { label: '游戏运行中', disabled: true };
  else if (busy) primary = { label: PHASE[s.phase], disabled: true };
  else if (resumable) primary = { label: `继续下载 ${s.pendingResume!.targetVersion}`, onClick: run(api.install) };
  else if (!s.installedVersion) primary = { label: s.remote ? `安装 ${s.remote.version}` : '安装', onClick: run(api.install), disabled: !s.remote };
  else if (hasUpdate) primary = { label: `更新到 ${s.remote!.version}`, onClick: run(api.install) };
  else primary = { label: '开始游戏', onClick: run(api.launchGame) };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-text">
          <p className="eyebrow">GAME LAUNCHER DEMO</p>
          <h1>Project Aurora</h1>
          <p className="meta">
            本地版本 <b data-testid="installed-version">{s.installedVersion ?? '未安装'}</b>
            <span className="dot">·</span>
            服务端版本 <b data-testid="remote-version">{s.remote?.version ?? '—'}</b>
            {s.remote && <span className={`tag tag-${s.remote.reason}`}>{REASON[s.remote.reason]}</span>}
            <span className="dot">·</span>
            状态 <b data-testid="phase">{PHASE[s.phase]}</b>
          </p>
        </div>
        <div className="actions">
          <button className="primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </button>
          <div className="secondary">
            <button onClick={run(api.checkUpdate)} disabled={busy}>检查更新</button>
            <button onClick={run(api.repair)} disabled={busy || playing || !s.installedVersion}>修复</button>
            <button onClick={run(api.launchGame)} disabled={busy || playing || !s.installedVersion}>开始游戏</button>
          </div>
        </div>
      </header>

      {toast && <div className="toast" role="alert">{toast}</div>}
      {s.error && <div className="toast error" role="alert">{s.error}</div>}

      <section className="progress-card">
        <div className="progress-head">
          <span>
            {t ? `${{ install: '安装', update: '增量更新', repair: '修复' }[t.kind]} → ${t.targetVersion}` : '没有进行中的任务'}
          </span>
          <span data-testid="progress-text">{t ? `${mb(t.doneBytes)} / ${mb(t.totalBytes)}（${pct.toFixed(1)}%）` : ''}</span>
        </div>
        <div className="bar">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        {t && (
          <dl className="stats">
            <div><dt>速度</dt><dd>{speed(t.speedBps)}</dd></div>
            <div><dt>块</dt><dd>{t.chunksDone}/{t.chunksTotal}</dd></div>
            <div><dt>网络下载</dt><dd>{mb(t.networkBytes)}</dd></div>
            <div><dt>断点续传</dt><dd data-testid="resumed">{mb(t.resumedBytes)}</dd></div>
            <div><dt>本地复用</dt><dd>{mb(t.reusedBytes)}</dd></div>
            <div><dt>重下块</dt><dd data-testid="retried">{t.chunksRetried}</dd></div>
            <div><dt>文件</dt><dd>下 {t.filesToDownload} / 跳 {t.filesSkipped} / 删 {t.filesRemoved}</dd></div>
          </dl>
        )}
        {resumable && s.phase !== 'downloading' && (
          <p className="hint">
            发现未完成的下载：{s.pendingResume!.targetVersion} 已完成 {mb(s.pendingResume!.doneBytes)} / {mb(s.pendingResume!.totalBytes)}
          </p>
        )}
        {s.lastResult && <p className="result" data-testid="last-result">{s.lastResult}</p>}
      </section>

      <div className="grid">
        <section className="card">
          <div className="card-head">
            <h2>下载源</h2>
            <button className="small" onClick={run(api.retestCdn)}>重新测速</button>
          </div>
          <table className="cdn">
            <tbody>
              {s.cdns.map((c) => (
                <tr key={c.id} className={c.active ? 'active' : ''}>
                  <td>{c.name}</td>
                  <td>{c.latencyMs === null ? '—' : `${c.latencyMs} ms`}</td>
                  <td><span className={`status status-${c.status}`}>{{ ok: '可用', down: '不可用', unknown: '未测' }[c.status]}</span></td>
                  <td>
                    {c.active && <span className="tag tag-active">使用中</span>}
                    {c.remembered && <span className="tag">记住</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>版本与灰度</h2>
          <dl className="kv">
            <div><dt>设备 ID</dt><dd className="mono" data-testid="device-id">{s.deviceId}</dd></div>
            <div><dt>灰度桶</dt><dd>{s.remote ? `${s.remote.bucket} / 100` : '—'}</dd></div>
            <div><dt>命中原因</dt><dd>{s.remote ? REASON[s.remote.reason] : '—'}</dd></div>
            <div><dt>更新计划</dt><dd>{s.plan ? `下载 ${s.plan.download} · 跳过 ${s.plan.skip} · 删除 ${s.plan.remove} · ${mb(s.plan.bytes)}` : '—'}</dd></div>
          </dl>
        </section>

        <section className="card">
          <h2>游戏进程</h2>
          <dl className="kv">
            <div><dt>运行中</dt><dd>{s.game.running ? `是（pid ${s.game.pid}）` : '否'}</dd></div>
            <div><dt>上次退出码</dt><dd data-testid="exit-code">{s.game.lastExitCode ?? '—'}</dd></div>
          </dl>
          <pre className="gamelog">{s.game.log.join('\n') || '还没有启动过'}</pre>
        </section>

        <section className="card">
          <h2>设置</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={s.settings.openAtLogin}
              onChange={(e) => run(() => api.setSetting('openAtLogin', e.target.checked))()}
            />
            开机启动（默认关）
          </label>
          <p className="muted">系统状态：openAtLogin={String(s.settings.openAtLogin)}，status={s.settings.loginItemStatus}</p>
          <p className="muted">窗口：{s.window.visible ? '显示' : '隐藏'} · 托盘：{s.window.tray ? '已创建' : '无'}</p>
          <div className="card-head">
            <h2>启动器自更新</h2>
            <button className="small" onClick={run(api.checkSelfUpdate)}>检查</button>
          </div>
          <p className="muted" data-testid="self-update">
            当前 {s.appVersion}；{s.selfUpdate.status === 'idle' ? '未检查' : s.selfUpdate.message ?? s.selfUpdate.status}
          </p>
          <p className="muted">
            <a href="https://github.com/alex4524/game-launcher-demo" target="_blank" rel="noreferrer">源码（GitHub）</a>
            <span className="dot">·</span>
            <a href="https://example.com/" target="_blank" rel="noreferrer">外部链接（会被拦截）</a>
          </p>
        </section>
      </div>

      <section className="card logs">
        <h2>事件日志</h2>
        <div className="loglist" ref={logRef}>
          {s.logs.map((l, i) => (
            <div key={i} className={`log log-${l.level}`}>
              <span className="time">{l.time}</span>
              {l.msg}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
