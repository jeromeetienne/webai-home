import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	build: {
		rollupOptions: {
			input: {
				main: resolve(import.meta.dirname, "public/index.html"),
			},
		},
	},
});
