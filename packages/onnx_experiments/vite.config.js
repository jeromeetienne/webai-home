import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        qwen: resolve(import.meta.dirname, 'public/qwen.html'),
        smollm: resolve(import.meta.dirname, 'public/smollm.html'),
        gemma: resolve(import.meta.dirname, 'public/gemma.html'),
      },
    },
  },
});
