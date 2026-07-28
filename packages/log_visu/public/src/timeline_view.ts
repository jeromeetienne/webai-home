import { TimelineModel } from "./timeline_model.js";
import type { ActorNode, ActorPosition, TimelineEvent } from "./types.js";

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Constants
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const SVG_NS = "http://www.w3.org/2000/svg";
const COLUMN_X: Record<string, number> = { left: 90, center: 400, right: 710 };
const ROW_HEIGHT = 100;
const TOP_MARGIN = 60;
const NODE_RADIUS = 22;
const MIN_HEIGHT = 260;
const PACKET_DURATION_MS = 700;

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
	private positionsByActorId: Map<string, ActorPosition>;

	constructor(svgEl: SVGSVGElement) {
		this.svgEl = svgEl;
		this.packetLayerEl = document.createElementNS(SVG_NS, "g");
		this.positionsByActorId = new Map();
	}

	/** Redraws the static scaffold — lane titles, actor nodes, and guide lines — for the given actors and events. */
	render(actors: ActorNode[], events: TimelineEvent[]): void {
		this.svgEl.replaceChildren();
		this.positionsByActorId = new Map();

		const rowCount = Math.max(1, ...actors.map((actor: ActorNode): number => actor.row + 1));
		const height = Math.max(MIN_HEIGHT, TOP_MARGIN + rowCount * ROW_HEIGHT + 40);
		this.svgEl.setAttribute("viewBox", `0 0 800 ${height}`);

		this._drawLaneTitle("Clients", COLUMN_X["left"]!);
		this._drawLaneTitle("Gateways", COLUMN_X["center"]!);
		this._drawLaneTitle("Workers", COLUMN_X["right"]!);

		for (const actor of actors) {
			const y: number = TOP_MARGIN + actor.row * ROW_HEIGHT + ROW_HEIGHT / 2;
			const x: number = COLUMN_X[actor.column]!;
			this.positionsByActorId.set(actor.id, { x, y });
		}

		for (const { fromId, toId } of this._distinctActorPairs(events)) {
			const from: ActorPosition | undefined = this.positionsByActorId.get(fromId);
			const to: ActorPosition | undefined = this.positionsByActorId.get(toId);
			if (from !== undefined && to !== undefined) this._drawGuideLine(from, to);
		}

		for (const actor of actors) {
			const position: ActorPosition = this.positionsByActorId.get(actor.id)!;
			this._drawActorNode(actor, position.x, position.y);
		}

		this.svgEl.appendChild(this.packetLayerEl);
	}

	/** Spawns a short animated packet traveling from the event's source actor to its destination. */
	spawnPacket(event: TimelineEvent): void {
		const from: ActorPosition | undefined = this.positionsByActorId.get(event.fromActorId);
		const to: ActorPosition | undefined = this.positionsByActorId.get(event.toActorId);
		if (from === undefined || to === undefined) return;

		const color: string = TimelineModel.colorForTaskId(event.taskId);
		const groupEl: SVGGElement = document.createElementNS(SVG_NS, "g");

		const dotEl: SVGCircleElement = document.createElementNS(SVG_NS, "circle");
		dotEl.setAttribute("r", "6");
		dotEl.setAttribute("fill", color);
		groupEl.appendChild(dotEl);

		const labelEl: SVGTextElement = document.createElementNS(SVG_NS, "text");
		labelEl.setAttribute("class", "packet-label");
		labelEl.setAttribute("text-anchor", "middle");
		labelEl.setAttribute("y", "-10");
		labelEl.textContent = event.messageType;
		groupEl.appendChild(labelEl);

		this.packetLayerEl.appendChild(groupEl);

		const animation = groupEl.animate(
			[
				{ transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0 },
				{ transform: `translate(${from.x}px, ${from.y}px)`, opacity: 1, offset: 0.1 },
				{ transform: `translate(${to.x}px, ${to.y}px)`, opacity: 1, offset: 0.9 },
				{ transform: `translate(${to.x}px, ${to.y}px)`, opacity: 0 },
			],
			{ duration: PACKET_DURATION_MS, easing: "ease-in-out" },
		);
		animation.addEventListener("finish", (): void => groupEl.remove());
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
			const pairKey: string = [event.fromActorId, event.toActorId].sort().join("|");
			if (seenPairKeys.has(pairKey)) continue;
			seenPairKeys.add(pairKey);
			pairs.push({ fromId: event.fromActorId, toId: event.toActorId });
		}
		return pairs;
	}

	private _drawLaneTitle(text: string, x: number): void {
		const titleEl: SVGTextElement = document.createElementNS(SVG_NS, "text");
		titleEl.setAttribute("class", "lane-title");
		titleEl.setAttribute("x", String(x));
		titleEl.setAttribute("y", "24");
		titleEl.setAttribute("text-anchor", "middle");
		titleEl.textContent = text;
		this.svgEl.appendChild(titleEl);
	}

	private _drawGuideLine(from: ActorPosition, to: ActorPosition): void {
		const lineEl: SVGLineElement = document.createElementNS(SVG_NS, "line");
		lineEl.setAttribute("class", "guide-line");
		lineEl.setAttribute("x1", String(from.x));
		lineEl.setAttribute("y1", String(from.y));
		lineEl.setAttribute("x2", String(to.x));
		lineEl.setAttribute("y2", String(to.y));
		this.svgEl.appendChild(lineEl);
	}

	private _drawActorNode(actor: ActorNode, x: number, y: number): void {
		const circleEl: SVGCircleElement = document.createElementNS(SVG_NS, "circle");
		circleEl.setAttribute("cx", String(x));
		circleEl.setAttribute("cy", String(y));
		circleEl.setAttribute("r", String(NODE_RADIUS));
		circleEl.setAttribute("fill", actor.column === "center" ? "#0ea5e9" : "#334155");
		circleEl.setAttribute("stroke", "#e2e8f0");
		circleEl.setAttribute("stroke-width", "1.5");
		this.svgEl.appendChild(circleEl);

		const labelEl: SVGTextElement = document.createElementNS(SVG_NS, "text");
		labelEl.setAttribute("class", "actor-label");
		labelEl.setAttribute("x", String(x));
		labelEl.setAttribute("y", String(y - NODE_RADIUS - 8));
		labelEl.setAttribute("text-anchor", "middle");
		labelEl.textContent = actor.label;
		this.svgEl.appendChild(labelEl);

		if (actor.sublabel !== undefined) {
			const sublabelEl: SVGTextElement = document.createElementNS(SVG_NS, "text");
			sublabelEl.setAttribute("class", "actor-sublabel");
			sublabelEl.setAttribute("x", String(x));
			sublabelEl.setAttribute("y", String(y + NODE_RADIUS + 16));
			sublabelEl.setAttribute("text-anchor", "middle");
			sublabelEl.textContent = actor.sublabel;
			this.svgEl.appendChild(sublabelEl);
		}
	}
}
