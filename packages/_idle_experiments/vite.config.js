import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ortDist = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const ortAssets = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  plugins: [{
    name: 'copy-onnx-runtime-web-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const fileName = request.url?.split('?')[0]?.slice(1);
        if (!fileName || !ortAssets.includes(fileName)) {
          next();
          return;
        }
        response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.end(readFileSync(resolve(ortDist, fileName)));
      });
    },
    generateBundle() {
      for (const fileName of ortAssets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(ortDist, fileName)) });
      }
    },
  }],
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        visibilityTimerLog: resolve(import.meta.dirname, 'public/visibility_timer_log/index.html'),
        qwen3GenerationLog: resolve(import.meta.dirname, 'public/qwen3_generation_log/index.html'),
        webWorkerCpuLog: resolve(import.meta.dirname, 'public/web_worker_cpu_log/index.html'),
        silentAudioLog: resolve(import.meta.dirname, 'public/silent_audio_log/index.html'),
      },
    },
  },
});
