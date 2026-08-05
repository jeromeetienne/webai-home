import { defineConfig } from 'vite';
import Fs from 'node:fs';
import Path from 'node:path';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The development server, plus the one endpoint that collects verification documents
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Where a posted verification document is written. */
const verificationDocumentDirectory = Path.resolve(import.meta.dirname, 'verification_documents');

/** Where a posted run report is written. */
const runReportDirectory = Path.resolve(import.meta.dirname, 'run_reports');

/**
 * Names the browser a verification document came from, so one file name says which browser
 * produced the result without the file having to be opened.
 *
 * @param {string} userAgent The user agent string the document carries.
 * @returns {string} A lower-case name safe to put in a file name.
 */
function browserNameOf(userAgent) {
	if (userAgent.includes('Electron/')) {
		return 'electron_chromium';
	}
	if (userAgent.includes('Firefox/')) {
		return 'firefox';
	}
	if (userAgent.includes('Edg/')) {
		return 'microsoft_edge';
	}
	if (userAgent.includes('Chrome/')) {
		return 'chrome';
	}
	if (userAgent.includes('Safari/')) {
		return 'safari';
	}
	return 'unknown_browser';
}

/**
 * Writes one posted JSON document to a directory, under a file name built from what it carries.
 *
 * @param {import('node:http').IncomingMessage} request The posted request.
 * @param {import('node:http').ServerResponse} response The response to end.
 * @param {string} directory Where to write the file.
 * @param {(document: any) => string} fileNameOf Builds the file name from the posted document.
 * @returns {void}
 */
function writePostedDocument(request, response, directory, fileNameOf) {
	if (request.method !== 'POST') {
		response.statusCode = 405;
		response.end('This endpoint accepts POST only');
		return;
	}
	/** @type {Buffer[]} */
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		try {
			const posted = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			const fileName = fileNameOf(posted);
			Fs.mkdirSync(directory, { recursive: true });
			Fs.writeFileSync(Path.join(directory, fileName), `${JSON.stringify(posted, undefined, '\t')}\n`, 'utf8');
			response.statusCode = 200;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ fileName }));
		} catch (error) {
			response.statusCode = 400;
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
}

/**
 * Collects what the experiment page posts, so a run in a browser this machine cannot script —
 * Safari, Firefox, or a phone on the same network — leaves its result on disk instead of only in
 * that browser's own console.
 *
 * Two things are collected. A verification document is the successful outcome, and is what
 * `tools/verify_account_key_signature.js` reads. A run report is every log line of one page load,
 * posted whether the page succeeded or failed, so a browser that could not generate or store a key
 * pair at all is told apart from a browser that never opened the page.
 *
 * @returns {import('vite').Plugin} The plugin.
 */
function collectVerificationDocuments() {
	return {
		name: 'collect-verification-documents',
		configureServer(server) {
			server.middlewares.use('/verification_document', (request, response) => {
				writePostedDocument(request, response, verificationDocumentDirectory, (signatureDocument) => {
					const browserName = browserNameOf(String(signatureDocument.userAgent ?? ''));
					const stamp = String(signatureDocument.signedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
					return `${browserName}_${signatureDocument.algorithmName}_${stamp}.json`;
				});
			});
			server.middlewares.use('/run_report', (request, response) => {
				writePostedDocument(request, response, runReportDirectory, (runReport) => {
					const browserName = browserNameOf(String(runReport.userAgent ?? ''));
					const stamp = String(runReport.finishedAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
					return `${browserName}_${stamp}.json`;
				});
			});
		},
	};
}

export default defineConfig({
	root: Path.resolve(import.meta.dirname, 'public'),
	publicDir: false,
	plugins: [collectVerificationDocuments()],
	build: {
		rollupOptions: {
			input: {
				home: Path.resolve(import.meta.dirname, 'public/index.html'),
				accountKeyPairLog: Path.resolve(import.meta.dirname, 'public/account_key_pair_log/index.html'),
			},
		},
	},
});
