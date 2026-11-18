// Types shared by main, preload, renderer and the fake server.
// Type-only: nothing in here may produce runtime code, because the sandboxed
// preload cannot require local modules.

export interface ChunkInfo {
  offset: number;
  size: number;
  sha256: string;
}

export interface FileEntry {
  /** POSIX relative path inside the game directory, e.g. "data/core.pak". */
  path: string;
  size: number;
  sha256: string;
  chunks: ChunkInfo[];
}

export interface Manifest {
  version: string;
  chunkSize: number;
  files: FileEntry[];
}

export interface CdnSource {
  id: string;
  name: string;
  url: string;
}

export type GrayReason = 'whitelist' | 'bucket' | 'stable';

export interface VersionResponse {
  version: string;
  reason: GrayReason;
  bucket: number;
  manifest: Manifest;
}

export interface RemoteConfig {
  cdns: CdnSource[];
}

export type Phase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'paused'
  | 'applying'
  | 'repairing'
  | 'playing'
  | 'error';

export type TaskKind = 'install' | 'update' | 'repair';

export interface TaskProgress {
  kind: TaskKind;
  targetVersion: string;
  totalBytes: number;
  doneBytes: number;
  /** Bytes fetched over the network in this run. */
  networkBytes: number;
  /** Bytes skipped because a previous run already finished them (resume). */
  resumedBytes: number;
  /** Bytes copied from an existing local file whose chunk hash still matched. */
  reusedBytes: number;
  speedBps: number;
  chunksDone: number;
  chunksTotal: number;
  /** Chunks actually fetched over the network in this run. */
  chunksFetched: number;
  /** Chunks that had to be fetched again (hash mismatch, timeout, error). */
  chunksRetried: number;
  filesToDownload: number;
  filesSkipped: number;
  filesRemoved: number;
}

export interface CdnView extends CdnSource {
  latencyMs: number | null;
  status: 'unknown' | 'ok' | 'down';
  active: boolean;
  failures: number;
  remembered: boolean;
}

export interface LogLine {
  time: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface LauncherState {
  appVersion: string;
  deviceId: string;
  installDir: string;
  installedVersion: string | null;
  remote: { version: string; reason: GrayReason; bucket: number } | null;
  plan: { download: number; skip: number; remove: number; bytes: number } | null;
  pendingResume: { targetVersion: string; doneBytes: number; totalBytes: number } | null;
  phase: Phase;
  task: TaskProgress | null;
  lastResult: string | null;
  cdns: CdnView[];
  game: { running: boolean; pid: number | null; lastExitCode: number | null; log: string[] };
  settings: { openAtLogin: boolean; loginItemStatus: string };
  selfUpdate: { status: 'idle' | 'checking' | 'available' | 'none' | 'error'; version?: string; message?: string };
  window: { visible: boolean; tray: boolean };
  error: string | null;
  logs: LogLine[];
}

export type SettingKey = 'openAtLogin';

/** The whitelist exposed by preload as `window.launcher`. */
export interface LauncherApi {
  getState(): Promise<LauncherState>;
  install(): Promise<void>;
  pause(): Promise<void>;
  checkUpdate(): Promise<void>;
  repair(): Promise<void>;
  launchGame(): Promise<void>;
  retestCdn(): Promise<void>;
  setSetting(key: SettingKey, value: boolean): Promise<void>;
  checkSelfUpdate(): Promise<void>;
  openExternal(url: string): Promise<void>;
  onState(cb: (s: LauncherState) => void): () => void;
}
