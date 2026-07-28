/** The central server URL, supplied as `?serverUrl=` or defaulting to the local server. */
const centralServerUrl = new URL(
	new URLSearchParams(location.search).get("serverUrl") ?? "http://localhost:8787",
);

/** Builds a WebSocket URL for the central server. */
export const centralServerWebSocketUrl = (): string => {
	const websocketUrl = new URL(centralServerUrl);
	websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
	return websocketUrl.toString();
};

/** Builds an HTTP asset URL on the central server. */
export const centralServerAssetUrl = (path: string): string => new URL(path, centralServerUrl).toString();
