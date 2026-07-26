import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const WASM_FILE = "ort-wasm-simd-threaded.jsep.wasm";
const MJS_FILE = "ort-wasm-simd-threaded.jsep.mjs";
const ORT_DIST = resolve("node_modules/onnxruntime-web/dist");

export default defineConfig({
  plugins: [
    {
      name: "serve-onnxruntime-wasm",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const requestPath = request.url?.split("?")[0];
          if (requestPath !== `/${WASM_FILE}` && requestPath !== `/${MJS_FILE}`) {
            next();
            return;
          }

          const fileName = requestPath.slice(1);
          response.setHeader("Content-Type", fileName === WASM_FILE ? "application/wasm" : "text/javascript");
          createReadStream(resolve(ORT_DIST, fileName)).pipe(response);
        });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: WASM_FILE,
          source: readFileSync(resolve(ORT_DIST, WASM_FILE)),
        });
        this.emitFile({
          type: "asset",
          fileName: MJS_FILE,
          source: readFileSync(resolve(ORT_DIST, MJS_FILE)),
        });
      },
    },
  ],
});
