// Sandboxed preload: only `electron` may be required here, and only a fixed list of
// functions is exposed. The page never sees ipcRenderer or the IPC event object.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LauncherApi, LauncherState, SettingKey } from '../shared/types';

const api: LauncherApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  install: () => ipcRenderer.invoke('install:start'),
  pause: () => ipcRenderer.invoke('install:pause'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  repair: () => ipcRenderer.invoke('repair:start'),
  launchGame: () => ipcRenderer.invoke('game:launch'),
  retestCdn: () => ipcRenderer.invoke('cdn:retest'),
  setSetting: (key: SettingKey, value: boolean) => ipcRenderer.invoke('settings:set', key, value),
  checkSelfUpdate: () => ipcRenderer.invoke('self-update:check'),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
  onState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: LauncherState) => cb(s);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
};

contextBridge.exposeInMainWorld('launcher', api);
