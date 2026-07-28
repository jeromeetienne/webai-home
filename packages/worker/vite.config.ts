import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	base: "/",
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
