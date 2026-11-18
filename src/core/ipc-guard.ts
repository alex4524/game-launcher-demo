import type { SettingKey } from '../shared/types';

/** The only origin allowed to call IPC: our own bundled UI served over the app:// scheme. */
export const APP_ORIGIN = 'app://launcher';

export function isTrustedSender(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'launcher';
  } catch {
    return false;
  }
}

/** External links we are willing to hand to the OS browser. Everything else is dropped. */
const EXTERNAL_HOSTS = new Set(['github.com']);

export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export class IpcArgError extends Error {}

type Validator<T> = (args: unknown[]) => T;

const none: Validator<[]> = (args) => {
  if (args.length !== 0) throw new IpcArgError(`expected no arguments, got ${args.length}`);
  return [];
};

const SETTING_KEYS: readonly SettingKey[] = ['openAtLogin'];

/** Argument validators per IPC channel. A channel missing here is rejected. */
export const ipcValidators = {
  'state:get': none,
  'install:start': none,
  'install:pause': none,
  'update:check': none,
  'repair:start': none,
  'game:launch': none,
  'cdn:retest': none,
  'self-update:check': none,
  'settings:set': ((args) => {
    if (args.length !== 2) throw new IpcArgError('expected (key, value)');
    const [key, value] = args;
    if (!SETTING_KEYS.includes(key as SettingKey)) throw new IpcArgError(`unknown setting ${String(key)}`);
    if (typeof value !== 'boolean') throw new IpcArgError('value must be boolean');
    return [key as SettingKey, value] as [SettingKey, boolean];
  }) as Validator<[SettingKey, boolean]>,
  'external:open': ((args) => {
    if (args.length !== 1) throw new IpcArgError('expected (url)');
    if (!isAllowedExternalUrl(args[0])) throw new IpcArgError('url not allowed');
    return [args[0]] as [string];
  }) as Validator<[string]>,
} satisfies Record<string, Validator<unknown[]>>;

export type IpcChannel = keyof typeof ipcValidators;

/** Full check used by every ipcMain.handle: origin first, then arguments. */
export function guardIpc<C extends IpcChannel>(
  channel: C,
  senderUrl: string | undefined | null,
  args: unknown[],
): ReturnType<(typeof ipcValidators)[C]> {
  if (!isTrustedSender(senderUrl)) throw new IpcArgError(`untrusted sender ${String(senderUrl)} on ${channel}`);
  const v = ipcValidators[channel] as Validator<unknown[]> | undefined;
  if (!v) throw new IpcArgError(`unknown channel ${channel}`);
  return v(args) as ReturnType<(typeof ipcValidators)[C]>;
}
