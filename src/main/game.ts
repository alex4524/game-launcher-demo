import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface GameHandlers {
  onLine(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

/**
 * Start the (fake) game as a separate OS process. The game is a Node script that the
 * launcher downloaded, so we run it with the app's own binary in Node mode instead of
 * depending on a system Node. Arguments are passed as an array: paths with spaces are safe.
 */
export function spawnGame(installDir: string, h: GameHandlers): ChildProcess {
  const child = spawn(process.execPath, [join(installDir, 'game.js'), '--from-launcher'], {
    cwd: installDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const pipe = (s: NodeJS.ReadableStream | null) => {
    let buf = '';
    s?.setEncoding('utf8');
    s?.on('data', (d: string) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) h.onLine(l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('error', (e) => h.onLine(`[launcher] spawn error: ${e.message}`));
  child.on('exit', (code, signal) => h.onExit(code, signal));
  return child;
}
