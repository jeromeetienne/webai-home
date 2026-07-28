import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	build: {
		rollupOptions: {
			input: {
				admin: resolve(import.meta.dirname, "public/admin/index.html"),
				debugIframe: resolve(import.meta.dirname, "public/debug_iframe/index.html"),
			},
		},
	},
});
