import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { LauncherState } from '../shared/types';

/**
 * Launcher self-update via electron-updater's generic provider (a plain HTTP folder with
 * latest-mac.yml). The demo only checks; downloading/installing needs a signed build on macOS.
 */
export function createSelfUpdater(feedUrl: string, report: (s: LauncherState['selfUpdate']) => void) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

  autoUpdater.on('update-available', (info) =>
    report({ status: 'available', version: info.version, message: `发现启动器新版本 ${info.version}（当前 ${app.getVersion()}）` }),
  );
  autoUpdater.on('update-not-available', (info) =>
    report({ status: 'none', version: info.version, message: `已是最新（当前 ${app.getVersion()}）` }),
  );
  autoUpdater.on('error', (e) => report({ status: 'error', message: e.message }));

  return async () => {
    report({ status: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      report({ status: 'error', message: (e as Error).message });
    }
  };
}
