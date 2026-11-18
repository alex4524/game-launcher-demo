import { describe, expect, it } from 'vitest';
import { guardIpc, isAllowedExternalUrl, isTrustedSender } from '../src/core/ipc-guard';

describe('IPC sender check', () => {
  it('trusts only our app:// page', () => {
    expect(isTrustedSender('app://launcher/index.html')).toBe(true);
    expect(isTrustedSender('app://launcher/')).toBe(true);
  });
  it.each([
    undefined,
    null,
    '',
    'https://evil.example/',
    'file:///Applications/x/index.html',
    'app://other/index.html',
    'http://app.launcher/',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isTrustedSender(url as string)).toBe(false);
  });
});

describe('IPC argument validation', () => {
  const ok = 'app://launcher/index.html';

  it('no-arg channels reject extra arguments', () => {
    expect(guardIpc('install:start', ok, [])).toEqual([]);
    expect(() => guardIpc('install:start', ok, ['../../etc'])).toThrow(/no arguments/);
  });

  it('settings:set only accepts known keys and booleans', () => {
    expect(guardIpc('settings:set', ok, ['openAtLogin', true])).toEqual(['openAtLogin', true]);
    expect(() => guardIpc('settings:set', ok, ['openAtLogin', 'yes'])).toThrow(/boolean/);
    expect(() => guardIpc('settings:set', ok, ['__proto__', true])).toThrow(/unknown setting/);
    expect(() => guardIpc('settings:set', ok, ['openAtLogin'])).toThrow();
  });

  it('external:open only allows https github.com', () => {
    expect(guardIpc('external:open', ok, ['https://github.com/alex4524/game-launcher-demo'])).toHaveLength(1);
    for (const bad of ['http://github.com/', 'file:///etc/passwd', 'https://evil.com/', 'javascript:alert(1)', 'https://user:pw@github.com/', 42]) {
      expect(() => guardIpc('external:open', ok, [bad])).toThrow(/not allowed/);
    }
  });

  it('rejects valid arguments from an untrusted sender', () => {
    expect(() => guardIpc('install:start', 'https://evil.example/', [])).toThrow(/untrusted sender/);
  });

  it('rejects unknown channels', () => {
    expect(() => guardIpc('fs:write' as never, ok, [])).toThrow(/unknown channel/);
  });

  it('isAllowedExternalUrl', () => {
    expect(isAllowedExternalUrl('https://github.com/x')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com.evil.com/x')).toBe(false);
  });
});
