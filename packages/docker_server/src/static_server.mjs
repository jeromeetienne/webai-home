// Serves the worker browser page's built files (`packages/worker_webpage/dist`), so a browser worker
// tab can be opened straight from this container instead of running `npm run dev --workspace
// @webai/worker-webpage` on the host. Plain Node — no dependency of its own, since this script's only
// job is serving a handful of static files by content-hashed name.
//
// Usage: node static_server.mjs <root-directory> <port>

import Fs from 'node:fs';
import Http from 'node:http';
import Path from 'node:path';

const [, , rootDirectoryArgument, portArgument] = process.argv;
if (rootDirectoryArgument === undefined || portArgument === undefined) {
	console.error('Usage: node static_server.mjs <root-directory> <port>');
	process.exit(1);
}
const rootDirectory = Path.resolve(rootDirectoryArgument);
const port = Number(portArgument);

/** The content type to serve each file extension with.
 * @type {Record<string, string>} */
const contentTypeByExtension = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.json': 'application/json; charset=utf-8',
};

const server = Http.createServer((request, response) => {
	const requestPathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
	const relativePath = requestPathname === '/' ? 'index.html' : requestPathname.replace(/^\/+/, '');
	const filePath = Path.join(rootDirectory, relativePath);

	if (filePath.startsWith(rootDirectory + Path.sep) === false && filePath !== rootDirectory) {
		response.statusCode = 403;
		response.end('Forbidden');
		return;
	}

	Fs.readFile(filePath, (error, contents) => {
		if (error !== null) {
			response.statusCode = 404;
			response.end('Not found');
			return;
		}
		response.setHeader('content-type', contentTypeByExtension[Path.extname(filePath)] ?? 'application/octet-stream');
		response.end(contents);
	});
});

server.listen(port, () => {
	console.log(`The worker page is listening on http://localhost:${port}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
