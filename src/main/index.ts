import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { guardIpc, isAllowedExternalUrl, isTrustedSender, type IpcChannel } from '../core/ipc-guard';
import { Launcher } from './launcher';
import { SettingsStore } from './settings';
import { createSelfUpdater } from './updater';

const SERVER = process.env.LAUNCHER_SERVER ?? 'http://127.0.0.1:7300';
const RENDERER_DIR = join(__dirname, 'renderer');
const START_HIDDEN = process.argv.includes('--hidden');

// Strict CSP for our own UI. No inline script, no eval, no remote anything.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let launcher: Launcher;

const logDir = join(app.getPath('userData'), 'logs');
mkdirSync(logDir, { recursive: true });
const writeLog = (line: string) => {
  try {
    appendFileSync(join(logDir, 'main.log'), `${line}\n`);
  } catch {
    /* ignore */
  }
};

function serveApp(): void {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'launcher') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const file = normalize(join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR + sep)) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function hardenContents(): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (isTrustedSender(url)) return;
      ev.preventDefault();
      launcher?.log('warn', `拦截页面跳转：${url}`);
    });
    contents.on('will-redirect', (ev, url) => {
      if (isTrustedSender(url)) return;
      ev.preventDefault();
      launcher?.log('warn', `拦截重定向：${url}`);
    });
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) {
        void shell.openExternal(url);
        launcher?.log('info', `用系统浏览器打开：${url}`);
      } else {
        launcher?.log('warn', `拦截新窗口：${url}`);
      }
      return { action: 'deny' };
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    launcher?.log('warn', `拒绝权限请求：${permission}`);
    cb(false);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Game Launcher Demo',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win?.show();
  });
  win.on('show', () => launcher.setWindow({ visible: true }));
  win.on('hide', () => launcher.setWindow({ visible: false }));
  // Closing the window keeps the launcher alive in the tray; "Quit" lives in the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    launcher.setWindow({ visible: false });
    launcher.log('info', '窗口已关闭，启动器留在托盘（菜单栏）继续运行');
  });
  // A page-initiated window.close() destroys the window without a 'close' event.
  // Drop the reference so the tray / dock can build a fresh window.
  win.on('closed', () => {
    win = null;
    launcher.setWindow({ visible: false });
    if (!quitting) launcher.log('info', '窗口被页面关闭，启动器留在托盘，可从托盘重新打开');
  });
  void win.loadURL('app://launcher/index.html');
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  win!.show();
  win!.focus();
  launcher.setWindow({ visible: true });
}

function createTray(checkSelfUpdate: () => Promise<void>): void {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'resources', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Game Launcher Demo');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示启动器', click: showWindow },
      { label: '检查启动器更新', click: () => void checkSelfUpdate() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  launcher.setWindow({ tray: true });
}

function registerIpc(checkSelfUpdate: () => Promise<void>): void {
  const handlers: Record<IpcChannel, (...a: never[]) => unknown> = {
    'state:get': () => structuredClone(launcher.state),
    'install:start': () => launcher.install(),
    'install:pause': () => launcher.pause(),
    'update:check': () => launcher.checkUpdate(),
    'repair:start': () => launcher.repair(),
    'game:launch': () => launcher.launchGame(),
    'cdn:retest': () => launcher.retestCdn(),
    'self-update:check': () => checkSelfUpdate(),
    'settings:set': (_key: never, value: never) => launcher.setOpenAtLogin(value as boolean),
    'external:open': (url: never) => shell.openExternal(url as string),
  };
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      let parsed: unknown[];
      try {
        // Every call: sender must be our own app:// page, arguments must match the schema.
        parsed = guardIpc(channel, event.senderFrame?.url, args) as unknown[];
      } catch (e) {
        launcher.log('error', `拒绝 IPC ${channel}：${(e as Error).message}`);
        throw e;
      }
      return (handlers[channel] as (...a: unknown[]) => unknown)(...parsed);
    });
  }
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  launcher?.stopGame();
});
app.on('window-all-closed', () => {
  /* stay in tray */
});

app.whenReady().then(async () => {
  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  launcher = new Launcher(join(app.getPath('userData'), 'game'), SERVER, app.getVersion(), settings, {
    push: (s) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
      try {
        win.webContents.send('state:changed', s);
      } catch {
        /* renderer is reloading */
      }
    },
    writeLog,
    loginItem: {
      get: () => {
        const s = app.getLoginItemSettings() as Electron.LoginItemSettings & { status?: string };
        return { openAtLogin: s.openAtLogin, status: s.status ?? 'n/a' };
      },
      set: (v) => app.setLoginItemSettings({ openAtLogin: v, args: ['--hidden'] }),
    },
  });
  const checkSelfUpdate = createSelfUpdater(`${SERVER}/updates`, (s) => {
    launcher.setSelfUpdate(s);
    if (s.message) launcher.log(s.status === 'error' ? 'error' : 'info', `启动器自更新：${s.message}`);
  });

  serveApp();
  hardenContents();
  registerIpc(checkSelfUpdate);
  createWindow();
  createTray(checkSelfUpdate);
  if (START_HIDDEN) launcher.setWindow({ visible: false });
  await launcher.init();
});
