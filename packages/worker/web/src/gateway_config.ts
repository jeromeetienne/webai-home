///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewayConfig — where this browser page reaches the central gateway, and with what token
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The central gateway URL, supplied as `?gatewayUrl=` or defaulting to the local gateway. */
const centralGatewayUrl = new URL(
	new URLSearchParams(location.search).get('gatewayUrl') ?? 'http://localhost:8787',
);

/**
 * Builds the addresses this page uses to reach the central gateway.
 *
 * Both the address and the token come from the page's own query string, so one browser can
 * be pointed at a gateway other than the local one without a rebuild.
 */
export class GatewayConfig {
	/**
	 * The bearer token this page authenticates with, supplied as `?authToken=` or defaulting to
	 * the gateway's own development default.
	 *
	 * The same token authenticates both the WebSocket connection that carries scheduling and the
	 * HTTP requests that carry diagnostics.
	 */
	static readonly authToken = new URLSearchParams(location.search).get('authToken') ?? 'development-token';

	/**
	 * Builds a WebSocket URL for the central gateway.
	 *
	 * @returns The gateway address with its scheme changed to the matching WebSocket scheme.
	 */
	static webSocketUrl(): string {
		const websocketUrl = new URL(centralGatewayUrl);
		websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
		return websocketUrl.toString();
	}

	/**
	 * Builds an HTTP asset URL on the central gateway.
	 *
	 * @param path The path to the asset, from the root of the gateway.
	 * @returns The full URL to request.
	 */
	static assetUrl(path: string): string {
		return new URL(path, centralGatewayUrl).toString();
	}
}
