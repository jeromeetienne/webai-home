/** The central gateway URL, supplied as `?gatewayUrl=` or defaulting to the local gateway. */
const centralGatewayUrl = new URL(
	new URLSearchParams(location.search).get("gatewayUrl") ?? "http://localhost:8787",
);

/** Builds a WebSocket URL for the central gateway. */
export const centralGatewayWebSocketUrl = (): string => {
	const websocketUrl = new URL(centralGatewayUrl);
	websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
	return websocketUrl.toString();
};

/** Builds an HTTP asset URL on the central gateway. */
export const centralGatewayAssetUrl = (path: string): string => new URL(path, centralGatewayUrl).toString();

/**
 * The bearer token this page authenticates with, supplied as `?authToken=` or defaulting to
 * the gateway's own development default.
 *
 * The same token authenticates both the WebSocket connection that carries scheduling and the
 * HTTP requests that carry diagnostics.
 */
export const centralGatewayAuthToken =
	new URLSearchParams(location.search).get("authToken") ?? "development-token";
