import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        visibilityTimerLog: resolve(import.meta.dirname, 'public/visibility_timer_log/index.html'),
      },
    },
  },
});
