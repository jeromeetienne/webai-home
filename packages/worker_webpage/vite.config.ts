import { createHash } from 'node:crypto';
import Fs from 'node:fs';
import Path from 'node:path';
import { defineConfig } from 'vite';

/**
 * `stage_llm_qwen3_0_6b_helper.ts` sets `env.wasm.wasmPaths = "/assets/"`, a literal string prefix.
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
const ortDistDir = Path.resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const ortDevServedFiles = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const ortBuildEmittedFile = 'ort-wasm-simd-threaded.jsep.mjs';
const gatewayFaviconPath = Path.resolve(import.meta.dirname, '../gateway/web/images/favicons/webai-at-home-logo.svg');

export default defineConfig({
	root: Path.resolve(import.meta.dirname, 'web'),
	base: process.env.WORKER_BASE_PATH ?? '/',
	plugins: [
		{
			name: 'serve-gateway-favicon',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url?.split('?')[0] !== '/images/favicons/webai-at-home-logo.svg') {
						next();
						return;
					}
					response.setHeader('Content-Type', 'image/svg+xml');
					response.end(Fs.readFileSync(gatewayFaviconPath));
				});
			},
			generateBundle() {
				this.emitFile({ type: 'asset', fileName: 'images/favicons/webai-at-home-logo.svg', source: Fs.readFileSync(gatewayFaviconPath) });
			},
		},
		{
			name: 'serve-onnxruntime-web-assets',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					const requestPath = request.url?.split('?')[0];
					const fileName = requestPath?.replace(/^\/assets\//, '');
					if (fileName === undefined || ortDevServedFiles.includes(fileName) === false) {
						next();
						return;
					}
					const contents = Fs.readFileSync(Path.resolve(ortDistDir, fileName));
					const etag = `"${createHash('sha256').update(contents).digest('hex')}"`;
					response.setHeader('Cache-Control', 'no-cache');
					response.setHeader('ETag', etag);
					if (request.headers['if-none-match'] === etag) {
						response.statusCode = 304;
						response.end();
						return;
					}
					response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
					response.end(contents);
				});
			},
			generateBundle() {
				this.emitFile({
					type: 'asset',
					fileName: `assets/${ortBuildEmittedFile}`,
					source: Fs.readFileSync(Path.resolve(ortDistDir, ortBuildEmittedFile)),
				});
			},
		},
	],
	build: {
		outDir: Path.resolve(import.meta.dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.wasm') ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]',
			},
		},
	},
	/**
	 * Matches `WORKER_PORT`'s default in the Docker image
	 * (see packages/docker_server/docker/docker-entrypoint.sh), so the worker page is reachable
	 * on the same port whether it is started locally or inside the container.
	 */
	server: {
		port: 8789,
		strictPort: true,
	},
	preview: {
		port: 8789,
		strictPort: true,
	},
});
