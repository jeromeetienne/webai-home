import { TimelineModel } from './timeline_model.js';
import type { ActorNode, ActorPosition, TimelineEvent } from './types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLUMN_X: Record<string, number> = { left: 90, center: 400, right: 710 };
const ROW_HEIGHT = 72;
const TOP_MARGIN = 42;
const NODE_RADIUS = 18;
const MIN_HEIGHT = 210;
const ZOOM_PANEL_WIDTH = 460;
const ZOOM_PANEL_HEIGHT = 300;
const ZOOM_PANEL_GAP = 10;
const ZOOM_MULTI_VIEW_GAP = 12;
const ZOOM_MULTI_VIEW_EXTENSION = 78;
const MAX_ZOOM_VIEWS = 2;
// Gap between the moving packet and the bottom line of its label, and the spacing between
// the label's own two lines. Both lines sit above the packet so neither covers it.
const LABEL_BASELINE_OFFSET = 9;
const LABEL_LINE_HEIGHT = 10;

type LinkSelection = {
	key: string;
	fromActorId: string;
	toActorId: string;
	toggleEventIndex: number;
};

type TaskDisplayField = {
	label: string;
	value: unknown;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TimelineView — draws the actor lanes and animates message packets between them
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Renders the swimlane diagram into an `<svg>` element: a static scaffold of actor
 * nodes and guide lines, plus short-lived animated packets spawned for each event
 * as playback reaches it. The center lane can hold several gateway nodes at once —
 * one per loaded log source — so multiple runs are visibly separated rather than
 * collapsed into a single node.
 */
export class TimelineView {
	private readonly svgEl: SVGSVGElement;
	private readonly packetLayerEl: SVGGElement;
	private readonly zoomViewLayerEl: SVGGElement;
	private readonly onEventClick: (event: TimelineEvent) => void;
	private positionsByActorId: Map<string, ActorPosition>;
	private actorsById: Map<string, ActorNode>;
	private guideLinesByLinkKey: Map<string, SVGLineElement>;
	private zoomedLinks: LinkSelection[];
	private diagramHeight: number;
	private currentFrameEvent: TimelineEvent | undefined;
	private zoomCardContentScale: number;

	/**
	 * @param svgEl The drawing the diagram is built in.
	 * @param onEventClick What to call when the reader clicks one event.
	 */
	constructor(svgEl: SVGSVGElement, onEventClick: (event: TimelineEvent) => void) {
		this.svgEl = svgEl;
		this.packetLayerEl = document.createElementNS(SVG_NS, 'g');
		this.zoomViewLayerEl = document.createElementNS(SVG_NS, 'g');
		this.onEventClick = onEventClick;
		this.positionsByActorId = new Map();
		this.actorsById = new Map();
		this.guideLinesByLinkKey = new Map();
		this.zoomedLinks = [];
		this.diagramHeight = MIN_HEIGHT;
		this.currentFrameEvent = undefined;
		this.zoomCardContentScale = 1;
	}

	/** Returns the current scale from diagram coordinates to screen pixels. */
	getRenderedScale(): number {
		const scale: number | undefined = this.svgEl.getScreenCTM()?.a;
		return scale === undefined || Number.isFinite(scale) === false || scale <= 0 ? 1 : scale;
	}

	/** Keeps zoom-card controls and text at a fixed screen size while the diagram scales. */
	setZoomCardContentScale(scale: number): void {
		this.zoomCardContentScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
		this._renderZoomView(this.currentFrameEvent);
	}

	/** Redraws the static scaffold — lane titles, actor nodes, and guide lines — for the given actors and events. */
		render(actors: ActorNode[], events: TimelineEvent[]): void {
		this.svgEl.replaceChildren();
		this.positionsByActorId = new Map();
		this.actorsById = new Map(actors.map((actor: ActorNode): [string, ActorNode] => [actor.id, actor]));
		this.guideLinesByLinkKey = new Map();
		this.currentFrameEvent = undefined;

		const rowCount = Math.max(1, ...actors.map((actor: ActorNode): number => actor.row + 1));
		const height = Math.max(MIN_HEIGHT, TOP_MARGIN + rowCount * ROW_HEIGHT + 40);
		this.diagramHeight = height;

		this._drawLaneTitle('Consumers', COLUMN_X['left']!);
		this._drawLaneTitle('Gateways', COLUMN_X['center']!);
		this._drawLaneTitle('Workers', COLUMN_X['right']!);

		for (const actor of actors) {
			const y: number = TOP_MARGIN + actor.row * ROW_HEIGHT + ROW_HEIGHT / 2;
			const x: number = COLUMN_X[actor.column]!;
			this.positionsByActorId.set(actor.id, { x, y });
		}

		for (const { fromId, toId } of this._distinctActorPairs(events)) {
			const from: ActorPosition | undefined = this.positionsByActorId.get(fromId);
			const to: ActorPosition | undefined = this.positionsByActorId.get(toId);
			if (from !== undefined && to !== undefined) this._drawGuideLine(from, to, this._linkKey(fromId, toId));
		}
		this.zoomedLinks = this.zoomedLinks.filter((zoomedLink: LinkSelection): boolean => this.guideLinesByLinkKey.has(zoomedLink.key));

		for (const actor of actors) {
			const position: ActorPosition = this.positionsByActorId.get(actor.id)!;
			this._drawActorNode(actor, position.x, position.y);
		}
		this._initializeTooltips();

		this.svgEl.appendChild(this.zoomViewLayerEl);
		this.svgEl.appendChild(this.packetLayerEl);
		this._updateSelectedGuideLines();
		this._renderZoomView(undefined);
	}

	/** Starts or stops monitoring the physical link crossed by the clicked event. */
	toggleLinkZoom(event: TimelineEvent): void {
		const key: string = this._linkKey(event.fromActorId, event.toActorId);
		const existingIndex: number = this.zoomedLinks.findIndex((zoomedLink: LinkSelection): boolean => zoomedLink.key === key);
		if (existingIndex !== -1 && this.zoomedLinks[existingIndex]!.toggleEventIndex === event.index) {
			this.zoomedLinks = this.zoomedLinks.filter((_: LinkSelection, index: number): boolean => index !== existingIndex);
		} else if (existingIndex !== -1) {
			this.zoomedLinks[existingIndex] = { ...this.zoomedLinks[existingIndex]!, toggleEventIndex: event.index };
		} else {
			const newZoomedLink: LinkSelection = { key, fromActorId: event.fromActorId, toActorId: event.toActorId, toggleEventIndex: event.index };
			this.zoomedLinks = [...this.zoomedLinks.slice(-(MAX_ZOOM_VIEWS - 1)), newZoomedLink];
		}
		this._updateSelectedGuideLines();
		this._renderZoomView(this.currentFrameEvent);
	}

	/** Draws the packet at an exact point in its visual journey, including while scrubbing. */
	setPlaybackFrame(event: TimelineEvent | undefined, progress: number): void {
		this.packetLayerEl.replaceChildren();
		const clampedProgress: number = Math.min(1, Math.max(0, progress));
		this.currentFrameEvent = event;
		if (event === undefined) {
			this._renderZoomView(undefined);
			return;
		}
		const from: ActorPosition | undefined = this.positionsByActorId.get(event.fromActorId);
		const to: ActorPosition | undefined = this.positionsByActorId.get(event.toActorId);
		if (from === undefined || to === undefined) {
			this._renderZoomView(event);
			return;
		}

		const color: string = TimelineModel.colorForTaskId(event.taskId);
		const groupEl: SVGGElement = document.createElementNS(SVG_NS, 'g');

		const dotEl: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
		dotEl.setAttribute('r', '6');
		dotEl.setAttribute('fill', color);
		dotEl.setAttribute('class', 'event-packet');
		dotEl.setAttribute('tabindex', '0');
		dotEl.setAttribute('role', 'button');
		dotEl.setAttribute('aria-label', `Show ${event.messageType} event`);
		dotEl.addEventListener('click', (domEvent: MouseEvent): void => {
			domEvent.stopPropagation();
			this.onEventClick(event);
		});
		dotEl.addEventListener('keydown', (domEvent: KeyboardEvent): void => {
			if (domEvent.key !== 'Enter' && domEvent.key !== ' ') return;
			domEvent.preventDefault();
			domEvent.stopPropagation();
			this.onEventClick(event);
		});
		groupEl.appendChild(dotEl);

		const labelEl: SVGTextElement = document.createElementNS(SVG_NS, 'text');
		labelEl.setAttribute('class', 'packet-label');
		labelEl.setAttribute('text-anchor', 'middle');
		labelEl.setAttribute('y', String(event.detail === undefined ? -LABEL_BASELINE_OFFSET : -LABEL_BASELINE_OFFSET - LABEL_LINE_HEIGHT));

		const messageTypeEl: SVGTSpanElement = document.createElementNS(SVG_NS, 'tspan');
		messageTypeEl.setAttribute('x', '0');
		messageTypeEl.textContent = event.messageType;
		labelEl.appendChild(messageTypeEl);

		if (event.detail !== undefined) {
			const detailEl: SVGTSpanElement = document.createElementNS(SVG_NS, 'tspan');
			detailEl.setAttribute('class', 'packet-detail');
			detailEl.setAttribute('x', '0');
			detailEl.setAttribute('dy', String(LABEL_LINE_HEIGHT));
			detailEl.textContent = event.detail;
			labelEl.appendChild(detailEl);
		}
		groupEl.appendChild(labelEl);

		const x: number = from.x + (to.x - from.x) * clampedProgress;
		const y: number = from.y + (to.y - from.y) * clampedProgress;
		const opacity: number = clampedProgress < 0.1 ? clampedProgress / 0.1 : clampedProgress > 0.9 ? (1 - clampedProgress) / 0.1 : 1;
		groupEl.setAttribute('transform', `translate(${x} ${y})`);
		groupEl.setAttribute('opacity', String(opacity));
		this.packetLayerEl.appendChild(groupEl);
		this._renderZoomView(event);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private _distinctActorPairs(events: TimelineEvent[]): Array<{ fromId: string; toId: string }> {
		const seenPairKeys: Set<string> = new Set();
		const pairs: Array<{ fromId: string; toId: string }> = [];
		for (const event of events) {
			const pairKey: string = this._linkKey(event.fromActorId, event.toActorId);
			if (seenPairKeys.has(pairKey)) continue;
			seenPairKeys.add(pairKey);
			pairs.push({ fromId: event.fromActorId, toId: event.toActorId });
		}
		return pairs;
	}

	private _linkKey(fromActorId: string, toActorId: string): string {
		return JSON.stringify([fromActorId, toActorId].sort());
	}

	private _drawLaneTitle(text: string, x: number): void {
		const titleEl: SVGTextElement = document.createElementNS(SVG_NS, 'text');
		titleEl.setAttribute('class', 'lane-title');
		titleEl.setAttribute('x', String(x));
		titleEl.setAttribute('y', '18');
		titleEl.setAttribute('text-anchor', 'middle');
		titleEl.textContent = text;
		this.svgEl.appendChild(titleEl);
	}

	private _drawGuideLine(from: ActorPosition, to: ActorPosition, linkKey: string): void {
		const lineEl: SVGLineElement = document.createElementNS(SVG_NS, 'line');
		lineEl.setAttribute('class', 'guide-line');
		lineEl.setAttribute('x1', String(from.x));
		lineEl.setAttribute('y1', String(from.y));
		lineEl.setAttribute('x2', String(to.x));
		lineEl.setAttribute('y2', String(to.y));
		this.svgEl.appendChild(lineEl);
		this.guideLinesByLinkKey.set(linkKey, lineEl);
	}

	private _updateSelectedGuideLines(): void {
		for (const [linkKey, lineEl] of this.guideLinesByLinkKey) {
			lineEl.classList.toggle('link-zoom-selected', this.zoomedLinks.some((zoomedLink: LinkSelection): boolean => zoomedLink.key === linkKey));
		}
	}

	private _renderZoomView(activeEvent: TimelineEvent | undefined): void {
		this.zoomViewLayerEl.replaceChildren();
		this.zoomedLinks = this.zoomedLinks.filter((zoomedLink: LinkSelection): boolean => {
			return this.positionsByActorId.has(zoomedLink.fromActorId) && this.positionsByActorId.has(zoomedLink.toActorId)
				&& this.actorsById.has(zoomedLink.fromActorId) && this.actorsById.has(zoomedLink.toActorId);
		});
		if (this.zoomedLinks.length === 0) {
			this._setViewBoxHeight(this.diagramHeight);
			return;
		}

		const zoomedLinksForLayout: LinkSelection[] = [...this.zoomedLinks].sort((left: LinkSelection, right: LinkSelection): number => {
			const leftFrom: ActorPosition = this.positionsByActorId.get(left.fromActorId)!;
			const leftTo: ActorPosition = this.positionsByActorId.get(left.toActorId)!;
			const rightFrom: ActorPosition = this.positionsByActorId.get(right.fromActorId)!;
			const rightTo: ActorPosition = this.positionsByActorId.get(right.toActorId)!;
			return Math.min(leftFrom.x, leftTo.x) - Math.min(rightFrom.x, rightTo.x);
		});
		let viewBoxHeight: number = this.diagramHeight;
		for (const zoomedLink of zoomedLinksForLayout) {
			const fromPosition: ActorPosition = this.positionsByActorId.get(zoomedLink.fromActorId)!;
			const toPosition: ActorPosition = this.positionsByActorId.get(zoomedLink.toActorId)!;
			const fromActor: ActorNode = this.actorsById.get(zoomedLink.fromActorId)!;
			const toActor: ActorNode = this.actorsById.get(zoomedLink.toActorId)!;
			const isActiveOnSelectedLink: boolean = activeEvent !== undefined && this._linkKey(activeEvent.fromActorId, activeEvent.toActorId) === zoomedLink.key;
			const centerDistance: number = Math.abs(toPosition.x - fromPosition.x);
			const basePanelWidth: number = centerDistance > 0 ? centerDistance : ZOOM_PANEL_WIDTH;
			// Keep each inter-lane zoom card in the same slot as the two-card layout. An
			// absent sibling must not make the remaining card narrower or recenter it.
			const innerGap: number = centerDistance > 0 ? ZOOM_MULTI_VIEW_GAP / 2 : 0;
			const outerExtension: number = centerDistance > 0 ? ZOOM_MULTI_VIEW_EXTENSION : 0;
			const panelWidth: number = basePanelWidth + outerExtension - innerGap;
			const basePanelX: number = centerDistance > 0 ? Math.min(fromPosition.x, toPosition.x) : Math.max(12, Math.min(800 - basePanelWidth - 12, ((fromPosition.x + toPosition.x) / 2) - basePanelWidth / 2));
			const panelSide: 'left' | 'right' = Math.min(fromPosition.x, toPosition.x) < COLUMN_X.center ? 'left' : 'right';
			const panelX: number = centerDistance > 0
				? basePanelX + (panelSide === 'left' ? -outerExtension : innerGap)
				: basePanelX;
			const panelHeight: number = ZOOM_PANEL_HEIGHT;
			const panelY: number = Math.max(fromPosition.y, toPosition.y) + NODE_RADIUS + ZOOM_PANEL_GAP;
			viewBoxHeight = Math.max(viewBoxHeight, panelY + panelHeight + ZOOM_PANEL_GAP);
			const linkCenterX: number = (fromPosition.x + toPosition.x) / 2;
			const linkCenterY: number = (fromPosition.y + toPosition.y) / 2;

			const connectorEl: SVGLineElement = document.createElementNS(SVG_NS, 'line');
			connectorEl.setAttribute('class', 'link-zoom-connector');
			connectorEl.setAttribute('x1', String(linkCenterX));
			connectorEl.setAttribute('y1', String(linkCenterY));
			connectorEl.setAttribute('x2', String(panelX + panelWidth / 2));
			connectorEl.setAttribute('y2', String(panelY));
			this.zoomViewLayerEl.appendChild(connectorEl);

			const foreignObjectEl: SVGForeignObjectElement = document.createElementNS(SVG_NS, 'foreignObject');
			foreignObjectEl.setAttribute('x', String(panelX));
			foreignObjectEl.setAttribute('y', String(panelY));
			foreignObjectEl.setAttribute('width', String(panelWidth));
			foreignObjectEl.setAttribute('height', String(panelHeight));

			const cardEl: HTMLDivElement = document.createElement('div');
			cardEl.className = 'link-zoom-card';
			cardEl.setAttribute('role', 'region');
			cardEl.setAttribute('aria-label', `Zoom view of ${fromActor.label} to ${toActor.label}`);
			const cardContentEl: HTMLDivElement = document.createElement('div');
			cardContentEl.className = 'link-zoom-card-content';
			cardContentEl.style.width = `${100 / this.zoomCardContentScale}%`;
			cardContentEl.style.height = `${100 / this.zoomCardContentScale}%`;
			cardContentEl.style.transform = `scale(${this.zoomCardContentScale})`;

			const selectedEvent: TimelineEvent | undefined = isActiveOnSelectedLink ? activeEvent : undefined;
			const hasActiveEvent: boolean = selectedEvent !== undefined;
			const jsonText: string | undefined = selectedEvent !== undefined
				? JSON.stringify(selectedEvent.logEntry, null, 2)
				: undefined;
			const travelsFromLeftToRight: boolean = selectedEvent === undefined || selectedEvent.fromActorId === zoomedLink.fromActorId;

			const actorsEl: HTMLDivElement = document.createElement('div');
			actorsEl.className = 'link-zoom-actors';
			actorsEl.append(this._buildZoomActorLabel(fromActor));
			if (hasActiveEvent) {
				const directionEl: HTMLSpanElement = document.createElement('span');
				directionEl.className = 'link-zoom-direction';
				directionEl.textContent = travelsFromLeftToRight ? '→' : '←';
				directionEl.setAttribute('aria-label', travelsFromLeftToRight ? 'travels left to right' : 'travels right to left');
				actorsEl.appendChild(directionEl);
			}
			actorsEl.append(this._buildZoomActorLabel(toActor));
			cardContentEl.appendChild(actorsEl);

			const messageEl: HTMLSpanElement = document.createElement('span');
			messageEl.className = 'link-zoom-message';
			messageEl.textContent = selectedEvent?.messageType ?? '';
			cardContentEl.appendChild(messageEl);

			const contentAreaEl: HTMLDivElement = document.createElement('div');
			contentAreaEl.className = 'link-zoom-content-area';
			const jsonContainerEl: HTMLDivElement = document.createElement('div');
			jsonContainerEl.className = 'link-zoom-json-container';
			const jsonEl: HTMLPreElement = document.createElement('pre');
			jsonEl.className = 'link-zoom-json';
			if (jsonText !== undefined) {
				jsonEl.textContent = jsonText;
				const copyButtonEl: HTMLButtonElement = document.createElement('button');
				copyButtonEl.className = 'link-zoom-copy';
				copyButtonEl.type = 'button';
				copyButtonEl.textContent = 'Copy';
				copyButtonEl.addEventListener('click', (domEvent: MouseEvent): void => {
					domEvent.stopPropagation();
					void this._copyZoomJson(jsonText, copyButtonEl);
				});
				jsonContainerEl.append(jsonEl, copyButtonEl);
			} else {
				jsonContainerEl.hidden = true;
			}
			if (jsonText === undefined) jsonContainerEl.appendChild(jsonEl);
			if (selectedEvent !== undefined) {
				const tabsEl: HTMLDivElement = document.createElement('div');
				tabsEl.className = 'link-zoom-tabs';
				tabsEl.setAttribute('role', 'tablist');
				const htmlTabEl: HTMLButtonElement = this._buildZoomTab('HTML', 'html', true);
				const jsonTabEl: HTMLButtonElement = this._buildZoomTab('JSON', 'json', false);
				const htmlViewEl: HTMLDivElement = this._buildMessageHtmlView(selectedEvent);
				htmlViewEl.id = `link-zoom-html-${selectedEvent.index}`;
				jsonContainerEl.id = `link-zoom-json-${selectedEvent.index}`;
				htmlTabEl.setAttribute('aria-controls', htmlViewEl.id);
				jsonTabEl.setAttribute('aria-controls', jsonContainerEl.id);
				const selectView = (view: 'html' | 'json'): void => {
					const showHtml: boolean = view === 'html';
					htmlViewEl.hidden = showHtml === false;
					jsonContainerEl.hidden = showHtml;
					htmlTabEl.classList.toggle('active', showHtml);
					jsonTabEl.classList.toggle('active', showHtml === false);
					htmlTabEl.setAttribute('aria-selected', String(showHtml));
					jsonTabEl.setAttribute('aria-selected', String(showHtml === false));
				};
				htmlTabEl.addEventListener('click', (): void => selectView('html'));
				jsonTabEl.addEventListener('click', (): void => selectView('json'));
				selectView('html');
				tabsEl.append(htmlTabEl, jsonTabEl);
				cardContentEl.appendChild(tabsEl);
				contentAreaEl.append(htmlViewEl, jsonContainerEl);
				cardContentEl.appendChild(contentAreaEl);
			}
			if (hasActiveEvent === false) {
				const emptyIconEl: HTMLSpanElement = document.createElement('span');
				emptyIconEl.className = 'bi bi-slash-circle link-zoom-empty-icon';
				emptyIconEl.setAttribute('aria-hidden', 'true');
				cardContentEl.appendChild(emptyIconEl);
			}
			cardEl.appendChild(cardContentEl);
			foreignObjectEl.appendChild(cardEl);
			this.zoomViewLayerEl.appendChild(foreignObjectEl);
		}
		this._setViewBoxHeight(viewBoxHeight);
	}

	private async _copyZoomJson(jsonText: string, buttonEl: HTMLButtonElement): Promise<void> {
		try {
			await navigator.clipboard.writeText(jsonText);
			buttonEl.textContent = 'Copied';
			window.setTimeout((): void => {
				if (buttonEl.isConnected) buttonEl.textContent = 'Copy';
			}, 1500);
		} catch {
			buttonEl.textContent = 'Copy failed';
		}
	}

	private _buildZoomActorLabel(actor: ActorNode): HTMLSpanElement {
		const labelEl: HTMLSpanElement = document.createElement('span');
		labelEl.className = 'link-zoom-actor';
		labelEl.textContent = actor.sublabel === undefined ? actor.label : `${actor.label} · ${actor.sublabel}`;
		return labelEl;
	}

	private _buildZoomTab(label: string, view: 'html' | 'json', isSelected: boolean): HTMLButtonElement {
		const tabEl: HTMLButtonElement = document.createElement('button');
		tabEl.className = `link-zoom-tab${isSelected ? ' active' : ''}`;
		tabEl.type = 'button';
		tabEl.setAttribute('role', 'tab');
		tabEl.setAttribute('aria-selected', String(isSelected));
		tabEl.dataset.view = view;
		tabEl.textContent = label;
		return tabEl;
	}

	/** Builds a readable message summary without exposing payload text as HTML. */
	private _buildMessageHtmlView(event: TimelineEvent): HTMLDivElement {
		const htmlViewEl: HTMLDivElement = document.createElement('div');
		htmlViewEl.className = 'link-zoom-html';
		htmlViewEl.setAttribute('role', 'tabpanel');
		const payload: Record<string, unknown> | undefined = TimelineView._record(event.logEntry.messagePayload);
		if (payload === undefined) {
			const emptyEl: HTMLParagraphElement = document.createElement('p');
			emptyEl.className = 'link-zoom-html-empty';
			emptyEl.textContent = 'No message details are available for this message.';
			htmlViewEl.appendChild(emptyEl);
			return htmlViewEl;
		}

		const fields: TaskDisplayField[] = event.messageType.startsWith('task.')
			? this._taskDisplayFields(payload)
			: TimelineView._messageDisplayFields(payload);
		this._appendDisplayFields(htmlViewEl, fields, 'No message details were recorded for this message.');
		return htmlViewEl;
	}

	/** Pulls the scheduling fields into a consistent order for every task message. */
	private _taskDisplayFields(payload: Record<string, unknown>): TaskDisplayField[] {
		const task: Record<string, unknown> | undefined = TimelineView._record(payload.task) ?? TimelineView._record(payload.update);
		const input: Record<string, unknown> | undefined = TimelineView._record(task?.input) ?? TimelineView._record(payload.input);
		const stageAssignment: Record<string, unknown> | undefined = TimelineView._record(task?.stageAssignment);
		return [
			{ label: 'Task request', value: task?.taskRequestId ?? payload.taskRequestId },
			{ label: 'Task', value: task?.taskId },
			{ label: 'Task type', value: input?.taskType },
			{ label: 'State', value: task?.state },
			{ label: 'Pipeline', value: task?.pipelineId },
			{ label: 'Pipeline version', value: task?.pipelineVersion },
			{ label: 'Pipeline stages', value: task?.pipelineStages },
			{ label: 'Current stage', value: task?.currentStage },
			{ label: 'Completed stages', value: task?.completedStageCount ?? task?.completedStages },
			{ label: 'Stage attempts', value: task?.currentStageAttempts },
			{ label: 'Task revision', value: task?.taskRevision },
			{ label: 'Updated', value: task?.updatedAt },
			{ label: 'Worker', value: stageAssignment?.workerDeviceId },
			{ label: 'Assignment', value: stageAssignment?.stageAssignmentId },
			{ label: 'Assignment attempt', value: stageAssignment?.attempt },
			{ label: 'Lease ends', value: stageAssignment?.leaseUntil },
			{ label: 'Accepted', value: stageAssignment?.acceptedAt },
			{ label: 'Input', value: input?.input },
			{ label: 'Result', value: task?.result },
			{ label: 'Error', value: task?.error },
		];
	}

	private _appendDisplayFields(containerEl: HTMLDivElement, fields: TaskDisplayField[], emptyText: string): void {
		const visibleFields: TaskDisplayField[] = fields.filter((field: TaskDisplayField): boolean => field.value !== undefined);
		if (visibleFields.length === 0) {
			const emptyEl: HTMLParagraphElement = document.createElement('p');
			emptyEl.className = 'link-zoom-html-empty';
			emptyEl.textContent = emptyText;
			containerEl.appendChild(emptyEl);
			return;
		}

		const fieldsEl: HTMLDListElement = document.createElement('dl');
		fieldsEl.className = 'link-zoom-task-fields';
		for (const field of visibleFields) {
			const labelEl: HTMLElement = document.createElement('dt');
			labelEl.textContent = field.label;
			const valueEl: HTMLElement = document.createElement('dd');
			valueEl.textContent = TimelineView._displayTaskValue(field.value);
			fieldsEl.append(labelEl, valueEl);
		}
		containerEl.appendChild(fieldsEl);
	}

	private static _record(value: unknown): Record<string, unknown> | undefined {
		return typeof value === 'object' && value !== null && Array.isArray(value) === false ? value as Record<string, unknown> : undefined;
	}

	private static _displayTaskValue(value: unknown): string {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
		return JSON.stringify(value);
	}

	/** Flattens every non-task payload so all protocol messages have a readable HTML view. */
	private static _messageDisplayFields(payload: Record<string, unknown>, prefix = ''): TaskDisplayField[] {
		const fields: TaskDisplayField[] = [];
		for (const [key, value] of Object.entries(payload)) {
			if (key === 'type') continue;
			const fieldName: string = prefix.length === 0 ? key : `${prefix}.${key}`;
			const nestedRecord: Record<string, unknown> | undefined = TimelineView._record(value);
			if (nestedRecord !== undefined) {
				fields.push(...TimelineView._messageDisplayFields(nestedRecord, fieldName));
				continue;
			}
			fields.push({ label: TimelineView._humanizeFieldName(fieldName), value });
		}
		return fields;
	}

	private static _humanizeFieldName(fieldName: string): string {
		const label: string = fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\./g, ' ');
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	private _setViewBoxHeight(height: number): void {
		this.svgEl.setAttribute('viewBox', `0 0 800 ${height}`);
	}

	private _drawActorNode(actor: ActorNode, x: number, y: number): void {
		const circleEl: SVGCircleElement = document.createElementNS(SVG_NS, 'circle');
		circleEl.setAttribute('cx', String(x));
		circleEl.setAttribute('cy', String(y));
		circleEl.setAttribute('r', String(NODE_RADIUS));
		circleEl.setAttribute('fill', actor.column === 'center' ? '#0d9fe8' : '#dce6f5');
		circleEl.setAttribute('stroke', actor.column === 'center' ? '#0877c9' : '#9fb0c8');
		circleEl.setAttribute('stroke-width', '1.5');
		this.svgEl.appendChild(circleEl);

		const labelEl: SVGTextElement = document.createElementNS(SVG_NS, 'text');
		labelEl.setAttribute('class', 'actor-label');
		labelEl.setAttribute('x', String(x));
		labelEl.setAttribute('y', String(y - NODE_RADIUS - 6));
		labelEl.setAttribute('text-anchor', 'middle');
		labelEl.textContent = actor.label;
		this.svgEl.appendChild(labelEl);

		if (actor.sublabel !== undefined) {
			const sublabelEl: SVGTextElement = document.createElementNS(SVG_NS, 'text');
			sublabelEl.setAttribute('class', 'actor-sublabel');
			sublabelEl.setAttribute('x', String(x));
			sublabelEl.setAttribute('y', String(y + NODE_RADIUS + 12));
			sublabelEl.setAttribute('text-anchor', 'middle');
			sublabelEl.textContent = actor.sublabel;
			if (actor.deviceId !== undefined && actor.sublabel !== actor.deviceId.replace('device-', '').slice(0, 8)) {
				sublabelEl.setAttribute('data-bs-toggle', 'tooltip');
				sublabelEl.setAttribute('data-bs-title', actor.deviceId);
				sublabelEl.setAttribute('data-bs-placement', 'top');
				sublabelEl.setAttribute('data-bs-container', 'body');
			}
			this.svgEl.appendChild(sublabelEl);
		}
	}

	private _initializeTooltips(): void {
		const bootstrap = (window as Window & {
			bootstrap?: { Tooltip: new (element: Element) => unknown };
		}).bootstrap;
		if (bootstrap === undefined) return;
		this.svgEl.querySelectorAll<HTMLElement>('[data-bs-toggle="tooltip"]').forEach((element: HTMLElement): void => {
			new bootstrap.Tooltip(element);
		});
	}
}
