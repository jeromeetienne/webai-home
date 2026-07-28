import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * `stage_llm_helper.ts` sets `env.wasm.wasmPaths = "/assets/"`, a literal string prefix.
 * Once `wasmPaths` is a plain string, onnxruntime-web builds every runtime file's URL as
 * `wasmPaths + fileName` (see its `wasm-factory.ts`), bypassing the `import.meta.url`-relative
 * resolution that lets Vite auto-bundle assets referenced via `new URL(..., import.meta.url)`.
 * So in dev mode NEITHER file below is reachable through Vite's normal asset pipeline — both
 * must be served from this literal `/assets/` path by hand, or they 404 (the `.wasm` request
 * actually falls through to Vite's SPA index.html fallback, silently returning HTML instead
 * of a 404) and the WebGPU/wasm backends fail to initialize.
 *
 * The production build only needs the `.mjs` emitted explicitly: the `.wasm` file already
 * lands in `dist/assets` for free because Vite's static analysis does detect the `new
 * URL(..., import.meta.url)` reference to it inside onnxruntime-web's bundled code (unlike the
 * `.mjs`, which is loaded via a plain, non-analyzable dynamic `import()`); emitting it again
 * here would collide with that automatically-emitted file of the same name.
 */
const ortDistDir = resolve(import.meta.dirname, "node_modules/onnxruntime-web/dist");
const ortDevServedFiles = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
const ortBuildEmittedFile = "ort-wasm-simd-threaded.jsep.mjs";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	base: "/",
	plugins: [
		{
			name: "serve-onnxruntime-web-assets",
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					const fileName = request.url?.split("?")[0]?.replace(/^\/assets\//, "");
					if (fileName === undefined || !ortDevServedFiles.includes(fileName)) {
						next();
						return;
					}
					response.setHeader("Content-Type", fileName.endsWith(".wasm") ? "application/wasm" : "text/javascript");
					response.end(readFileSync(resolve(ortDistDir, fileName)));
				});
			},
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: `assets/${ortBuildEmittedFile}`,
					source: readFileSync(resolve(ortDistDir, ortBuildEmittedFile)),
				});
			},
		},
	],
	build: {
		outDir: resolve(import.meta.dirname, "dist"),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".wasm") ? "assets/[name][extname]" : "assets/[name]-[hash][extname]",
			},
		},
	},
});
