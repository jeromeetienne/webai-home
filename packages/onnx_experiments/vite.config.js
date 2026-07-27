import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        qwen: resolve(import.meta.dirname, 'public/qwen3-0.6b/index.html'),
        smollm: resolve(import.meta.dirname, 'public/smoll2-360m/index.html'),
        gemma: resolve(import.meta.dirname, 'public/gemma4-e2b-it/index.html'),
      },
    },
  },
});
