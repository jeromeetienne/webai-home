import type { StageName, StagePayload, ClientMessage } from '@webai/protocol';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import { StageDevFormulaHelper } from './stage_dev_formula_helper';
import { StageLlmQwen3_0_6bHelper } from './stage_llm_qwen3_0_6b_helper';
import { StageLlmGemmaNanoChromeHelper } from './stage_llm_gemma_nano_chrome_helper';
import { GatewayConfig } from './gateway_config';
import { GatewayLink } from './gateway_link';
import { LeaseHeartbeat } from './lease_heartbeat';
import { DiagnosticsReporter } from './diagnostics_reporter';
import { PageElements } from './page_elements';
import { PageMarkup } from './page_markup';
import { WorkerEventLog } from './worker_event_log';
import { WorkerStageOffer } from './worker_stage_offer';
import { ThemeToggle } from './theme_toggle.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerPage — the worker browser page: connects, registers, and runs assigned stages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** A message received from the central gateway. */
type GatewayMessage = {
	/** The message category. */
	type: string;
	deviceId?: string;
	/** The task identifier for a stage message. */
	taskId?: string;
	/** The durable identifier for the current stage assignment. */
	assignmentId?: string;
	/** The number of the current assignment attempt. */
	attempt?: number;
	/** The stage for a stage message. */
	stage?: StageName;
	/** The value for a stage message: a plain number for formula stages, or an LLM payload. */
	value?: StagePayload;
	/** When the assignment lease runs out, unless the worker extends it with `stage.heartbeat`. */
	leaseUntil?: string;
	/** Which computation the assigned stage needs, such as `dev_formula_multiply` or `llm_qwen3_0_6b_shard`. */
	computation?: string;
	/** The assigned stage's position in its pipeline, counted from zero. */
	stageIndex?: number;
	/** The pipeline specifications the gateway has loaded, in reply to `pipelines.get`. */
	pipelines?: { stages: { name: string; computation: string }[] }[];
	/** When the authenticated session expires, in reply to `authenticate`. */
	expiresAt?: string;
};

/** The stages this browser could offer, as the loaded pipelines describe them. */
type OfferedStages = { stageNames: string[]; llmShardIndexes: number[]; builtInModelStageNames: string[] };

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Worker Page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs the worker browser page.
 *
 * The page opens one connection to the central gateway, asks which pipelines the gateway has
 * loaded, gets itself ready to run the stages it recognises, registers as a worker, and then
 * runs each stage the gateway assigns to it. It holds that connection for as long as the tab
 * is displayed, renewing its session and extending the lease of the assignment it is working
 * on so neither expires underneath it.
 */
export class WorkerPage {
	private readonly statusEl: HTMLElement;
	private readonly nameInputEl: HTMLInputElement;
	private readonly connectButtonEl: HTMLButtonElement;
	private readonly disconnectButtonEl: HTMLButtonElement;
	private readonly workerNameEl: HTMLElement;
	private readonly deviceIdEl: HTMLElement;
	private readonly stagesEl: HTMLElement;
	/** The message shown when the language model built into the browser is not ready to run. */
	private readonly builtInModelNoticeEl: HTMLElement;
	private readonly builtInModelMessageEl: HTMLElement;
	/** The button that asks the browser to download its own language model. */
	private readonly builtInModelDownloadButtonEl: HTMLButtonElement;

	private readonly eventLog = new WorkerEventLog();
	/** The stages the page URL restricts this worker browser to, if it names any. */
	private readonly requestedStageNames: readonly string[];

	/** The active WebSocket connection, when the worker browser is connected. */
	private socket: WebSocket | undefined;
	/** Whether this browser has completed registration on the current connection. */
	private isRegistered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: number | undefined;
	/**
	 * Whether the connection should be opened again as soon as the current one has closed.
	 *
	 * Which stages this browser offers is decided once per connection, just before it
	 * registers. Downloading the browser's own language model therefore only takes effect on
	 * the next connection, and this asks for one.
	 */
	private isReconnectRequested = false;
	/**
	 * The stages this worker browser advertises, decided once the gateway has sent its
	 * pipelines. It stays empty until then, because which stage names exist is decided by the
	 * pipelines the gateway has loaded rather than by a list built into this page.
	 */
	private enabledStageNames: string[] = [];
	/** Prevents another connection attempt while enabled LLM shards are preloading. */
	private isPreparing = false;

	/** Finds every element the page is built around. */
	constructor() {
		this.statusEl = PageElements.getElement('#status');
		this.nameInputEl = PageElements.getInput('#name');
		this.connectButtonEl = PageElements.getButton('#connect');
		this.disconnectButtonEl = PageElements.getButton('#disconnect');
		this.workerNameEl = PageElements.getElement('#worker-name');
		this.deviceIdEl = PageElements.getElement('#device-id');
		this.stagesEl = PageElements.getElement('#stages');
		this.builtInModelNoticeEl = PageElements.getElement('#built-in-model-notice');
		this.builtInModelMessageEl = PageElements.getElement('#built-in-model-message');
		this.builtInModelDownloadButtonEl = PageElements.getButton('#built-in-model-download');
		this.requestedStageNames = WorkerStageOffer.requestedStageNamesFromUrl(location.search);
	}

	/** Starts the worker browser user interface and opens the first connection. */
	start(): void {
		ThemeToggle.setup();

		// Use the URL-provided name for embedded worker pages, and generate a random
		// name for standalone pages so multiple workers can still be opened safely.
		const workerNameFromUrl: string | null = new URLSearchParams(location.search).get('workerName');
		const trimmedWorkerName = workerNameFromUrl?.trim() ?? '';
		this.nameInputEl.value = trimmedWorkerName === ''
			? `browser-worker-${crypto.randomUUID().slice(0, 8)}`
			: (workerNameFromUrl ?? '');
		this.workerNameEl.textContent = this.nameInputEl.value;
		this.renderStages();
		this.eventLog.render();

		/** Opens a WebSocket connection when the connect button is clicked. */
		this.connectButtonEl.addEventListener('click', (): void => {
			this.connectToGateway();
		});

		// The browser only starts downloading its own language model when the person using the page
		// asks for it, so this download cannot be started while the page is loading. Once the model
		// is there, the connection is opened again, because the stages a browser offers are decided
		// as it registers.
		this.builtInModelDownloadButtonEl.addEventListener('click', (): void => {
			this.downloadBuiltInModel();
		});

		/** Closes the WebSocket connection when the disconnect button is clicked. */
		this.disconnectButtonEl.addEventListener('click', (): void => {
			if (this.socket !== undefined) this.socket.close(1000, 'Disconnected by worker');
		});

		// Leaving a page does not always destroy it. A browser tab that navigates away keeps the
		// page it left, and every connection that page holds, in its back/forward cache, so that
		// going back can restore the page instead of loading it again. The central gateway learns
		// that a worker browser has gone only when that browser's connection closes, so a worker
		// page held in the back/forward cache stayed registered: opening one debug page after
		// another in the same browser tab left the first page's workers listed and still offered
		// work (see https://github.com/webai-at-home/webai-at-home/issues/58).
		//
		// Closing the connection while the page is being put away is what makes the departure
		// visible to the gateway. The connection is not reopened here, because the page may never
		// be displayed again.
		window.addEventListener('pagehide', (): void => {
			if (this.socket === undefined) return;
			LeaseHeartbeat.stop();
			DiagnosticsReporter.stop();
			this.socket.close(1000, 'Worker page is no longer displayed');
			this.socket = undefined;
			this.isRegistered = false;
		});

		// Going back displays this page again, restored from the back/forward cache with the
		// connection closed above. The page is not loaded again in that case, so nothing else
		// would reconnect it, and the restored page would sit there offering no work at all.
		window.addEventListener('pageshow', (event: PageTransitionEvent): void => {
			if (event.persisted === false) return;
			// A page put away while its language-model shards were still loading left this set,
			// which would refuse the reconnection below.
			this.isPreparing = false;
			this.connectToGateway();
		});

		// Connect automatically once the page controls and event handlers are ready.
		this.connectToGateway();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Connection
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Opens a connection to the central gateway and registers this browser as a worker.
	 *
	 * The connect button calls this, and so does a page restored from the back/forward cache,
	 * whose earlier connection was closed as the page was put away.
	 */
	private connectToGateway(): void {
		// Do not open a new connection if one is already open or in the process of opening.
		if (this.isPreparing || (this.socket !== undefined && this.socket.readyState !== WebSocket.CLOSED)) return;

		// The shards this browser preloads depend on which stages it will offer, and that is
		// decided from the pipelines the gateway sends. So the connection opens first, and the
		// preload happens once the pipelines have arrived, just before registration.
		this.socket = new WebSocket(GatewayConfig.webSocketUrl());
		/**
		 * The connection this attempt opened.
		 *
		 * A connection that is closed while the page is not being displayed can deliver its
		 * close event after the page has already opened a replacement, so every handler below
		 * checks that it is still the current connection before changing shared page state.
		 */
		const openedSocket = this.socket;
		this.isRegistered = false;

		this.statusEl.textContent = 'Connecting';
		this.statusEl.className = 'badge text-bg-warning';
		this.connectButtonEl.disabled = true;

		/** Authenticates the worker browser after connection. */
		this.socket.addEventListener('open', (): void => {
			this.statusEl.textContent = 'Connected';
			this.statusEl.className = 'badge text-bg-success';
			this.connectButtonEl.classList.add('d-none');
			this.disconnectButtonEl.classList.remove('d-none');
			this.nameInputEl.disabled = true;
			const message: ClientMessage = { type: 'authenticate', token: GatewayConfig.authToken };
			if (this.socket !== undefined) GatewayLink.send(this.socket, message);
			this.eventLog.add({ direction: 'sent', type: message.type, timestamp: new Date().toISOString() });
		});

		/** Handles messages received from the central gateway. */
		this.socket.addEventListener('message', (event: MessageEvent): void => {
			this.handleGatewayMessage(event);
		});

		/** Restores the disconnected state when the WebSocket closes. */
		this.socket.addEventListener('close', (): void => {
			if (this.socket !== undefined && this.socket !== openedSocket) return;
			LeaseHeartbeat.stop();
			this.isRegistered = false;
			if (this.sessionRenewalTimer !== undefined) window.clearTimeout(this.sessionRenewalTimer);
			this.sessionRenewalTimer = undefined;
			// Posts whatever is still buffered, so the last messages before a disconnection are
			// still recorded rather than lost with the page's state.
			DiagnosticsReporter.stop();
			this.statusEl.textContent = 'Disconnected';
			this.statusEl.className = 'badge text-bg-danger';
			this.connectButtonEl.classList.remove('d-none');
			this.connectButtonEl.disabled = false;
			this.disconnectButtonEl.classList.add('d-none');
			this.nameInputEl.disabled = false;
			this.socket = undefined;
			if (this.isReconnectRequested === false) return;
			this.isReconnectRequested = false;
			this.connectToGateway();
		});
	}

	/**
	 * Authenticates again before the current session runs out.
	 *
	 * This page holds its connection open for as long as the browser tab is open, which is
	 * longer than one session lasts, and the gateway refuses messages once a session has
	 * expired. Renewing keeps the connection usable without reconnecting.
	 *
	 * @param openSocket The connection whose session should be renewed.
	 * @param expiresAt When the current session expires, as the gateway stated it.
	 */
	private scheduleSessionRenewal(openSocket: WebSocket, expiresAt: string | undefined): void {
		if (this.sessionRenewalTimer !== undefined) window.clearTimeout(this.sessionRenewalTimer);
		if (expiresAt === undefined) return;
		this.sessionRenewalTimer = window.setTimeout((): void => {
			if (openSocket.readyState !== WebSocket.OPEN) return;
			GatewayLink.send(openSocket, { type: 'authenticate', token: GatewayConfig.authToken });
		}, SessionRenewal.renewAfterMs(expiresAt));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Incoming Messages
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one message from the central gateway and acts on it.
	 *
	 * @param event The message event delivered by the WebSocket connection.
	 */
	private handleGatewayMessage(event: MessageEvent): void {
		/** The wrapper the gateway message travelled in. */
		const frame = JSON.parse(event.data as string) as { v?: number; id?: string; inReplyTo?: string; body?: GatewayMessage };
		/** The decoded gateway message. */
		const message: GatewayMessage = frame.body ?? ({ type: 'error' } as GatewayMessage);
		this.eventLog.add({
			direction: 'received',
			type: message.type,
			timestamp: new Date().toISOString(),
			...(message.taskId === undefined || message.taskId === '' ? {} : { taskId: message.taskId }),
			...(message.stage === undefined ? {} : { stage: message.stage }),
		});
		// Ask the gateway which pipelines it has loaded before registering, so this browser
		// can offer every stage whose computation it implements, including stages of a
		// pipeline added after this browser was built.
		if (message.type === 'authenticated' && this.socket !== undefined) {
			// This page keeps its connection open indefinitely, and the gateway enforces the
			// expiry it just advertised, so the session has to be renewed before that moment
			// or the next message this page sends is refused.
			this.scheduleSessionRenewal(this.socket, message.expiresAt);
			// A renewal is answered with "authenticated" too. Asking for the pipelines again
			// each time would restart the whole registration sequence, so it is only asked
			// for on the first one.
			if (this.isRegistered) return;
			const request: ClientMessage = { type: 'pipelines.get' };
			GatewayLink.send(this.socket, request);
			this.eventLog.add({ direction: 'sent', type: request.type, timestamp: new Date().toISOString() });
			return;
		}
		if (message.type === 'pipelines' && this.socket !== undefined) {
			this.registerOfferedStages(WorkerStageOffer.offeredStages(message.pipelines ?? [], this.requestedStageNames));
			return;
		}
		if (message.type === 'registered') {
			this.isRegistered = true;
			this.deviceIdEl.textContent = message.deviceId ?? 'Not assigned';
			// Reporting can only start now: the gateway names the device the report is for,
			// and it issues that name here.
			if (message.deviceId !== undefined) DiagnosticsReporter.start(message.deviceId, GatewayConfig.authToken);
		}
		DiagnosticsReporter.record('received', message.type, frame.id);
		if (message.type === 'stage.cancel' && message.taskId !== undefined) {
			LeaseHeartbeat.stop(message.assignmentId);
			StageLlmQwen3_0_6bHelper.clearTask(message.taskId);
			StageLlmGemmaNanoChromeHelper.clearTask(message.taskId);
			return;
		}
		// The gateway answers each lease heartbeat with a later expiry. Nothing has to be
		// done with it: the assignment is still this browser's, which is the whole point.
		if (message.type === 'stage.lease.extended') return;
		if (message.type !== 'stage.assign' || message.stage === undefined || message.value === undefined || message.taskId === undefined || message.assignmentId === undefined || message.attempt === undefined) return;
		this.runAssignedStage(message);
	}

	/**
	 * Gets this browser ready for the stages it could offer, then registers as a worker.
	 *
	 * @param offered The stages this browser could offer, from the loaded pipelines.
	 */
	private registerOfferedStages(offered: OfferedStages): void {
		this.isPreparing = true;
		this.prepareOfferedStages(offered)
			.then((stageNames) => {
				this.isPreparing = false;
				if (this.socket === undefined) return;
				this.enabledStageNames = stageNames;
				this.renderStages();
				if (stageNames.length === 0) {
					this.statusEl.textContent = 'No stage to run';
					this.statusEl.className = 'badge text-bg-danger';
					this.eventLog.add({ direction: 'local', type: 'worker.error', timestamp: new Date().toISOString(), message: 'This browser can run none of the stages the loaded pipelines define' });
					this.socket.close(1000, 'No stage to run');
					return;
				}
				this.statusEl.textContent = 'Connected';
				this.statusEl.className = 'badge text-bg-success';
				const register: ClientMessage = { type: 'register', role: 'worker', name: this.nameInputEl.value, stageNames };
				GatewayLink.send(this.socket, register);
				this.eventLog.add({ direction: 'sent', type: register.type, timestamp: new Date().toISOString() });
			})
			.catch((error: unknown) => {
				this.isPreparing = false;
				this.statusEl.textContent = 'Shard loading failed';
				this.statusEl.className = 'badge text-bg-danger';
				this.eventLog.add({ direction: 'local', type: 'worker.error', timestamp: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) });
				this.socket?.close(1000, 'Shard loading failed');
			});
	}

	/**
	 * Runs one assigned stage and reports its result, or its failure, to the gateway.
	 *
	 * @param message The `stage.assign` message, with its task, assignment, and value present.
	 */
	private runAssignedStage(message: GatewayMessage): void {
		/** The task identifier and stage captured for the async result below. */
		const { taskId, assignmentId, attempt, stage, value } = message as Required<Pick<GatewayMessage, 'taskId' | 'assignmentId' | 'attempt' | 'stage' | 'value'>>;
		const acceptedMessage: ClientMessage = { type: 'stage.accepted', taskId, assignmentId, attempt };
		if (this.socket !== undefined) GatewayLink.send(this.socket, acceptedMessage);
		if (this.socket !== undefined) LeaseHeartbeat.start(this.socket, { taskId, assignmentId, attempt, leaseUntil: message.leaseUntil });
		// The assignment says which computation to run and which position in its pipeline
		// the stage occupies. This browser never has to recognise the stage name.
		const computation = message.computation ?? '';
		/**
		 * Runs the assigned stage with whichever helper implements its computation.
		 *
		 * @returns The stage result, once the computation has produced it.
		 */
		const runComputation = (): Promise<StagePayload> => {
			if (StageLlmQwen3_0_6bHelper.implementsComputation(computation)) return StageLlmQwen3_0_6bHelper.compute(message.stageIndex ?? 0, taskId, value as Exclude<StagePayload, number>);
			if (StageLlmGemmaNanoChromeHelper.implementsComputation(computation)) return StageLlmGemmaNanoChromeHelper.compute(taskId, value as Exclude<StagePayload, number>);
			return Promise.resolve(StageDevFormulaHelper.compute(computation, value as number));
		};
		runComputation()
			.then((computedValue) => {
				LeaseHeartbeat.stop(assignmentId);
				const resultMessage: ClientMessage = {
					type: 'stage.result',
					taskId,
					assignmentId,
					attempt,
					stage,
					value: computedValue,
				};
				if (this.socket !== undefined) GatewayLink.send(this.socket, resultMessage);
				this.eventLog.add({ direction: 'sent', type: resultMessage.type, timestamp: new Date().toISOString(), taskId, stage });
			})
			.catch((error: unknown) => {
				LeaseHeartbeat.stop(assignmentId);
				// A failed stage abandons the task, so drop whatever this browser was keeping
				// for it: a shard's key-value cache, or an answer the browser's own language
				// model is still producing. Both are left alone when no such state exists.
				StageLlmQwen3_0_6bHelper.clearTask(taskId);
				StageLlmGemmaNanoChromeHelper.clearTask(taskId);
				const failedMessage: ClientMessage = {
					type: 'stage.failed',
					taskId,
					assignmentId,
					attempt,
					stage,
					error: error instanceof Error ? error.message : String(error),
				};
				if (this.socket !== undefined) GatewayLink.send(this.socket, failedMessage);
				this.eventLog.add({ direction: 'sent', type: failedMessage.type, timestamp: new Date().toISOString(), taskId, stage, message: failedMessage.error });
			});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Getting Ready To Work
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Gets this browser ready to run the stages it could offer, and reports which of them it
	 * can actually offer.
	 *
	 * Two stages need something to be in place before work arrives. A language-model shard
	 * stage needs its shard downloaded, which is done here so that a shard is never downloaded
	 * while a task is waiting for it. A stage that runs the language model built into the
	 * browser needs that model to be ready, and this browser drops the stage rather than
	 * advertising work it would fail, because the browser may have no built-in model at all or
	 * may not have downloaded it yet.
	 *
	 * @param offered The stages this browser could offer, from the loaded pipelines.
	 * @returns The stage names this browser can offer, in the order they were found.
	 */
	private async prepareOfferedStages(offered: OfferedStages): Promise<string[]> {
		let stageNames = offered.stageNames;
		if (offered.builtInModelStageNames.length > 0) {
			this.statusEl.textContent = 'Checking the built-in language model';
			this.statusEl.className = 'badge text-bg-warning';
			const readiness = await StageLlmGemmaNanoChromeHelper.readiness();
			if (readiness.status === 'ready') {
				this.hideBuiltInModelNotice();
			} else {
				stageNames = stageNames.filter((stageName) => offered.builtInModelStageNames.includes(stageName) === false);
				this.showBuiltInModelNotice(readiness.message, readiness.status === 'user_gesture_required');
				this.eventLog.add({ direction: 'local', type: 'worker.built_in_model', timestamp: new Date().toISOString(), message: readiness.message });
			}
		}
		if (offered.llmShardIndexes.length > 0) {
			this.statusEl.textContent = 'Downloading model files';
			this.statusEl.className = 'badge text-bg-warning';
		}
		await StageLlmQwen3_0_6bHelper.preload(offered.llmShardIndexes, (phase) => {
			this.statusEl.textContent = phase === 'downloading' ? 'Downloading model files' : 'Loading model in GPU';
		});
		return stageNames;
	}

	/**
	 * Downloads the language model built into the browser, at the reader's request, and offers
	 * the stage that needs it on the next connection.
	 */
	private downloadBuiltInModel(): void {
		this.builtInModelDownloadButtonEl.disabled = true;
		this.builtInModelMessageEl.textContent = "Downloading the browser's built-in language model.";
		StageLlmGemmaNanoChromeHelper.download((fraction) => {
			this.builtInModelMessageEl.textContent = `Downloading the browser's built-in language model: ${Math.round(fraction * 100)} per cent.`;
		})
			.then((readiness) => {
				this.builtInModelDownloadButtonEl.disabled = false;
				if (readiness.status !== 'ready') {
					this.showBuiltInModelNotice(readiness.message, readiness.status === 'user_gesture_required');
					return;
				}
				this.hideBuiltInModelNotice();
				this.eventLog.add({ direction: 'local', type: 'worker.built_in_model', timestamp: new Date().toISOString(), message: "The browser's built-in language model is ready" });
				if (this.socket === undefined) {
					this.connectToGateway();
					return;
				}
				this.isReconnectRequested = true;
				this.socket.close(1000, 'Offering the built-in language-model stage');
			})
			.catch((error: unknown) => {
				this.builtInModelDownloadButtonEl.disabled = false;
				this.showBuiltInModelNotice(error instanceof Error ? error.message : String(error), true);
			});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Drawing
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/** Shows the stages this worker browser currently offers. */
	private renderStages(): void {
		this.stagesEl.innerHTML = this.enabledStageNames.length === 0
			? '<span class="text-body-secondary">Waiting for the gateway\'s pipelines</span>'
			: this.enabledStageNames.map((stageName) => `<span class="badge text-bg-light border">${PageMarkup.escapeHtml(stageName)}</span>`).join('');
	}

	/**
	 * Shows why a stage that needs the browser's own language model is not being offered.
	 *
	 * @param text The reason to display.
	 * @param isDownloadOffered Whether the reader can fix it by starting the download.
	 */
	private showBuiltInModelNotice(text: string, isDownloadOffered: boolean): void {
		this.builtInModelMessageEl.textContent = text;
		this.builtInModelNoticeEl.classList.remove('d-none');
		this.builtInModelDownloadButtonEl.classList.toggle('d-none', isDownloadOffered === false);
	}

	/** Hides the notice about the browser's own language model. */
	private hideBuiltInModelNotice(): void {
		this.builtInModelNoticeEl.classList.add('d-none');
		this.builtInModelDownloadButtonEl.classList.add('d-none');
	}
}

new WorkerPage().start();
