import type { Device, PipelineSpecification, ProtocolErrorCode } from '@webai/protocol';
import WebSocket from 'ws';
import type { TaskSocket } from './consumer_client.js';
import { ObserverClient } from './observer_client.js';
import { CliError, type CliExitCode } from '../libs/cli_errors.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewaySession — connects as an observer and resolves once there is something to show
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `GatewaySession.connect` needs to open and watch an observer connection. */
export type GatewaySessionOptions = {
	url: string;
	authToken: string;
	timeoutMs: number;
	/** Called with the full current device list, every time the central gateway reports a change. */
	onDevices: (devices: Device[]) => void;
	/** Requests the registered pipelines too, and resolves only once they have also arrived. */
	onPipelines?: (pipelines: PipelineSpecification[]) => void;
	/**
	 * Called if the connection is lost after `connect` has already resolved — that is, during
	 * `status --watch`. Not called when `close` on the returned session is what closed it.
	 */
	onConnectionLost?: (error: CliError) => void;
};

/** An open observer connection, and the one way callers are expected to close it. */
export type GatewaySessionHandle = {
	client: ObserverClient;
	/** Closes the connection without treating the resulting disconnect as a failure. */
	close: () => void;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gateway Session
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Opens an `ObserverClient` connection and resolves once it has what the caller asked for —
 * the first device list, and the registered pipelines too when `onPipelines` was given —
 * turning every way that can fail into a `CliError` already carrying the right exit code.
 */
export class GatewaySession {
	/**
	 * @param options Where to connect, what to wait for, and how long to wait.
	 * @returns A handle to the open connection, once it has reported what was asked for.
	 * @throws {CliError} If the connection fails, the token is refused, the wait times out,
	 * or the gateway sends something this client cannot make sense of.
	 */
	static async connect(options: GatewaySessionOptions): Promise<GatewaySessionHandle> {
		return new Promise<GatewaySessionHandle>((resolve, reject) => {
			let isSettled = false;
			let isClosingIntentionally = false;
			let hasDevices = false;
			let hasPipelines = options.onPipelines === undefined;

			const timer = setTimeout((): void => {
				fail(new CliError(`Timed out after ${options.timeoutMs}ms waiting for the central gateway to answer`, 3));
			}, options.timeoutMs);
			// A pending timeout must not be the only reason this process stays alive.
			timer.unref?.();

			const succeed = (): void => {
				if (isSettled || hasDevices === false || hasPipelines === false) return;
				isSettled = true;
				clearTimeout(timer);
				resolve({
					client,
					close: (): void => {
						isClosingIntentionally = true;
						client.close();
					},
				});
			};
			const fail = (error: CliError): void => {
				if (isSettled) {
					if (isClosingIntentionally === false) options.onConnectionLost?.(error);
					return;
				}
				isSettled = true;
				clearTimeout(timer);
				client.close();
				reject(error);
			};

			const socket = new WebSocket(options.url) as unknown as TaskSocket;
			const client = new ObserverClient(socket, {
				onDevices: (devices): void => {
					hasDevices = true;
					options.onDevices(devices);
					succeed();
				},
				...(options.onPipelines === undefined ? {} : {
					onPipelines: (pipelines: PipelineSpecification[]): void => {
						hasPipelines = true;
						options.onPipelines?.(pipelines);
						succeed();
					},
				}),
				onError: (error): void => {
					fail(new CliError(error.message, GatewaySession.exitCodeForError(error.code)));
				},
				onConnectionChange: (isConnected): void => {
					if (isConnected) return;
					if (isClosingIntentionally) return;
					fail(new CliError('The connection to the central gateway closed', 1));
				},
			}, options.authToken, options.onPipelines !== undefined);
		});
	}

	/**
	 * Maps a protocol error code to the exit code a command ends with.
	 *
	 * `INVALID_MESSAGE` is this client's own code for a frame it could not read, so it is
	 * treated as a malformed response rather than a rejection by the gateway.
	 *
	 * @param code The error code the central gateway (or this client) reported.
	 * @returns The exit code a command fails with.
	 */
	private static exitCodeForError(code: ProtocolErrorCode): CliExitCode {
		if (code === 'INVALID_MESSAGE') return 4;
		if (code === 'AUTHORISATION' || code === 'AUTHENTICATION_REQUIRED') return 2;
		return 1;
	}
}
