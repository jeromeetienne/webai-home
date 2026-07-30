import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "public"),
	build: {
		rollupOptions: {
			input: {
				home: resolve(import.meta.dirname, "public/home/index.html"),
				monitor: resolve(import.meta.dirname, "public/monitor/index.html"),
				debug: resolve(import.meta.dirname, "public/debug/index.html"),
				debugIframe: resolve(import.meta.dirname, "public/debug_iframe/index.html"),
				debugIframeDevFormula: resolve(import.meta.dirname, "public/debug_iframe_dev_formula/index.html"),
				debugIframeLlmQwen3_0_6bSharded: resolve(import.meta.dirname, "public/debug_iframe_llm_qwen3_0_6b_sharded/index.html"),
			},
		},
	},
});
