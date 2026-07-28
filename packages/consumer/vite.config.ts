import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	build: { outDir: resolve(import.meta.dirname, "dist"), emptyOutDir: true },
});
