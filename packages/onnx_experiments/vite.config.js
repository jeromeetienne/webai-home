import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        qwen: resolve(import.meta.dirname, 'qwen.html'),
        smollm: resolve(import.meta.dirname, 'smollm.html'),
      },
    },
  },
});
