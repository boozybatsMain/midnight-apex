import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

// Dev pages under /dev/*.html are module test benches; include them in the build too.
const devPages = existsSync('dev')
  ? Object.fromEntries(readdirSync('dev').filter((f) => f.endsWith('.html')).map((f) => [`dev_${f.replace('.html', '')}`, resolve('dev', f)]))
  : {};

export default defineConfig({
  // Relative asset paths so the build works from any hosted URL (Genex hosting).
  base: './',
  server: { port: 5391, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { main: resolve('index.html'), ...devPages } },
  },
});
