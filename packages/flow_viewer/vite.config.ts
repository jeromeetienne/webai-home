import Fs from 'node:fs';
import Path from 'node:path';
import { defineConfig } from 'vite';

const gatewayFaviconPath = Path.resolve(import.meta.dirname, '../gateway/web/images/favicons/webai-at-home-logo.svg');

export default defineConfig({
	root: Path.resolve(import.meta.dirname, 'web'),
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
	],
	build: {
		rollupOptions: {
			input: {
				main: Path.resolve(import.meta.dirname, 'web/index.html'),
			},
		},
	},
});
