// Bundles main, preload and the fake server with esbuild. The renderer is built by Vite.
// The preload is bundled into one file because sandboxed preloads cannot require local modules.
import { build } from 'esbuild';

const only = process.argv[2];
const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: false, logLevel: 'info' };

const targets = {
  main: { entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', external: ['electron', 'electron-updater'] },
  preload: { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', external: ['electron'] },
  server: { entryPoints: ['server/index.ts'], outfile: 'dist/server.cjs' },
};

for (const [name, opts] of Object.entries(targets)) {
  if (only && only !== name) continue;
  await build({ ...common, ...opts });
}
