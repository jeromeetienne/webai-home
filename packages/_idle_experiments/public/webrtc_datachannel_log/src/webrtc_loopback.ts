///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebrtcLoopback — two RTCPeerConnections in this same page, connected only
//	to each other, kept open with a steady ping/ack exchange
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Chrome's own documentation lists "real-time connections (WebSockets and WebRTC)" as exempt
 * from background-tab timer throttling, alongside audio playback. A loopback connection — two
 * peer connections in the same page, offering and answering each other directly — tests that
 * exemption without needing a signaling server or any other machine: both sides negotiate their
 * own local host candidates and connect to each other over localhost.
 */

/** How the loopback data channel is doing, as reported by the two badges this drives. */
export type WebrtcState = 'connecting' | 'open' | 'closed';

/** How often a ping is sent and a round trip is measured. */
const PING_INTERVAL_MS = 1000;

/** Opens a loopback WebRTC data channel and keeps a steady ping/ack exchange running over it. */
export class WebrtcLoopback {
	private static senderConnection: RTCPeerConnection | undefined;
	private static receiverConnection: RTCPeerConnection | undefined;
	private static senderChannel: RTCDataChannel | undefined;
	private static sentAtByPingId = new Map<string, number>();

	/**
	 * Negotiates the loopback connection and starts the ping/ack exchange once it is open.
	 *
	 * @param onLogRow Called with a `webrtc` row for every state change and every round trip.
	 * @param onStateChange Called with the channel's current state, once immediately and again
	 * on every change.
	 */
	static async start(onLogRow: (message: string) => void, onStateChange: (state: WebrtcState) => void): Promise<void> {
		onStateChange('connecting');
		const senderConnection = new RTCPeerConnection();
		const receiverConnection = new RTCPeerConnection();
		WebrtcLoopback.senderConnection = senderConnection;
		WebrtcLoopback.receiverConnection = receiverConnection;

		senderConnection.addEventListener('icecandidate', (event) => {
			if (event.candidate !== null) void receiverConnection.addIceCandidate(event.candidate);
		});
		receiverConnection.addEventListener('icecandidate', (event) => {
			if (event.candidate !== null) void senderConnection.addIceCandidate(event.candidate);
		});

		const senderChannel = senderConnection.createDataChannel('loopback');
		WebrtcLoopback.senderChannel = senderChannel;
		const receiverChannelPromise = new Promise<RTCDataChannel>((resolve) => {
			receiverConnection.addEventListener('datachannel', (event) => resolve(event.channel));
		});

		senderChannel.addEventListener('open', () => {
			onLogRow('loopback data channel open');
			onStateChange('open');
			WebrtcLoopback.loopPing();
		});
		senderChannel.addEventListener('close', () => {
			onLogRow('loopback data channel closed');
			onStateChange('closed');
		});
		senderChannel.addEventListener('message', (event: MessageEvent<string>) => {
			const sentAtMs = WebrtcLoopback.sentAtByPingId.get(event.data);
			if (sentAtMs === undefined) return;
			WebrtcLoopback.sentAtByPingId.delete(event.data);
			onLogRow(`ping round trip took ${(performance.now() - sentAtMs).toFixed(1)} ms`);
		});

		const offer = await senderConnection.createOffer();
		await senderConnection.setLocalDescription(offer);
		await receiverConnection.setRemoteDescription(offer);
		const answer = await receiverConnection.createAnswer();
		await receiverConnection.setLocalDescription(answer);
		await senderConnection.setRemoteDescription(answer);

		const receiverChannel = await receiverChannelPromise;
		receiverChannel.addEventListener('message', (event: MessageEvent<string>) => {
			if (receiverChannel.readyState === 'open') receiverChannel.send(event.data);
		});
	}

	/**
	 * Sends one ping a second for as long as the channel stays open. Each round trip is timed
	 * and reported by the `message` listener registered in {@link start}, not here — a ping
	 * whose ack never comes back just stays in {@link sentAtByPingId}, harmlessly, until the
	 * page reloads.
	 */
	private static loopPing(): void {
		let pingIndex = 0;
		const send = (): void => {
			const channel = WebrtcLoopback.senderChannel;
			if (channel === undefined || channel.readyState !== 'open') return;
			const pingId = `ping:${pingIndex}`;
			pingIndex += 1;
			WebrtcLoopback.sentAtByPingId.set(pingId, performance.now());
			channel.send(pingId);
			setTimeout(send, PING_INTERVAL_MS);
		};
		send();
	}
}
