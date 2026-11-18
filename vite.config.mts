import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src/renderer'),
  base: '/',
  plugins: [react()],
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    // No inline polyfill script: keeps the page compatible with `script-src 'self'`.
    modulePreload: { polyfill: false },
    target: 'chrome130',
  },
});
