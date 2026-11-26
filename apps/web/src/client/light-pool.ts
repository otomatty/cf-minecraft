import type { ClientCore } from "./client-core.ts";

export const LIGHT_RECORD_BYTES = 4112;
export type LightMutation = { type: "packet"; data: Uint8Array<ArrayBuffer> } |
	{ type: "predict"; x: number; y: number; z: number; block: number } | { type: "reset" };
export type LightRequest = (LightMutation & { sequence: number; generation?: number }) |
	{ type: "camera"; x: number; z: number };
export type LightReply = { type: "ready" } |
	{ type: "light"; sequence: number; pending: number; updates: Uint8Array<ArrayBuffer> };
export interface LightWorker {
	onmessage: ((event: MessageEvent<LightReply>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(message: LightRequest, transfer: Transferable[]): void;
	terminate(): void;
}
const key = (x: number, z: number) => `${x},${z}`;
export function packetCoords(data: Uint8Array): [number, number] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return [view.getInt32(1, false), view.getInt32(5, false)];
}

/** Owns ordering, chunk lifetimes and acknowledgement accounting on the UI thread. */
export class LightPool {
	private worker: LightWorker | undefined;
	private ready = false;
	private failed = false;
	private queued: LightRequest[] = [];
	private generations = new Map<string, number>();
	private generation = 0;
	private sent = 0;
	private acknowledged = 0;
	private pending = 0;
	private elapsed = 0;
	private cameraAt = -Infinity;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly core: ClientCore;

	constructor(core: ClientCore, create: () => LightWorker) {
		this.core = core;
		try {
			this.worker = create();
			core.externalLight(true);
			core.observeLight = change => this.mutate(change);
			this.worker.onerror = this.worker.onmessageerror = () => this.fallback();
			this.worker.onmessage = ({ data }) => {
				const start = performance.now();
				try {
					if (!this.worker) return;
					if (data.type === "ready") {
						this.ready = true;
						clearTimeout(this.timer);
						for (const message of this.queued) this.post(message);
						this.queued = [];
					} else {
						const accepted: Uint8Array[] = [];
						if (data.updates.length % LIGHT_RECORD_BYTES) throw new Error("Invalid light batch");
						const view = new DataView(data.updates.buffer, data.updates.byteOffset, data.updates.byteLength);
						for (let offset = 0; offset < data.updates.length; offset += LIGHT_RECORD_BYTES) {
							const cx = view.getInt32(offset, true), cz = view.getInt32(offset + 8, true);
							if (this.generations.get(key(cx, cz)) === view.getUint32(offset + 12, true)) {
								accepted.push(data.updates.subarray(offset, offset + LIGHT_RECORD_BYTES));
							}
						}
						if (accepted.length) core.applyLightUpdates(accepted);
						// Only acknowledge after every received light record has been applied.
						this.acknowledged = data.sequence;
						this.pending = data.pending;
					}
				} catch { this.fallback(); }
				finally { this.elapsed += performance.now() - start; }
			};
			this.timer = setTimeout(() => this.fallback(), 10000);
		} catch { this.fallback(); }
	}

	get useFallback(): boolean { return !this.worker; }
	get queue(): number { return this.worker ? this.pending + this.sent - this.acknowledged : this.core.lightPending; }

	private post(message: LightRequest): void {
		try { this.worker?.postMessage(message, message.type === "packet" ? [message.data.buffer] : []); }
		catch { this.fallback(); }
	}

	private mutate(change: LightMutation): void {
		let generation: number | undefined;
		if (change.type === "reset") this.generations.clear();
		if (change.type === "packet" && (change.data[0] === 1 || change.data[0] === 2)) {
			const [cx, cz] = packetCoords(change.data);
			if (change.data[0] === 1) {
				generation = ++this.generation;
				this.generations.set(key(cx, cz), generation);
				this.core.lightGeneration(cx, cz, generation);
			} else this.generations.delete(key(cx, cz));
		}
		const message = { ...change, sequence: ++this.sent, generation };
		if (this.ready) this.post(message);
		else this.queued.push(message);
	}

	private fallback(): void {
		if (this.failed) return;
		this.dispose();
		this.core.externalLight(false);
	}

	dispose(): void {
		this.failed = true;
		clearTimeout(this.timer);
		this.worker?.terminate();
		this.worker = undefined;
		this.queued = [];
		this.core.observeLight = undefined;
	}

	/** Camera traffic is throttled; initial work itself advances independently of frames. */
	step(x: number, z: number): number {
		if (!this.worker) this.elapsed += this.core.stepLight(x, z);
		else if (this.ready && performance.now() - this.cameraAt >= 100) {
			this.cameraAt = performance.now();
			this.post({ type: "camera", x, z });
		}
		const elapsed = this.elapsed;
		this.elapsed = 0;
		return elapsed;
	}
}

export interface LightEngineCore {
	packet(data: Uint8Array): number;
	predictBlock(x: number, y: number, z: number, block: number): boolean;
	resetWorld(): void;
	lightGeneration(cx: number, cz: number, generation: number): void;
	stepLight(x: number, z: number): number;
	readonly lightPending: number;
	takeLightUpdates(): Uint8Array<ArrayBuffer>;
}

/** Testable worker dispatcher. Each scheduled slice yields back to the message loop. */
export class LightEngine {
	private readonly core: LightEngineCore;
	private readonly send: (reply: LightReply) => void;
	private readonly schedule: (run: () => void) => void;
	private scheduled = false;
	private sequence = 0;
	private x = 0;
	private z = 0;
	constructor(core: LightEngineCore, send: (reply: LightReply) => void, schedule: (run: () => void) => void) {
		this.core = core; this.send = send; this.schedule = schedule;
	}
	handle(message: LightRequest): void {
		if (message.type === "camera") { this.x = message.x; this.z = message.z; }
		else {
			this.sequence = message.sequence;
			if (message.type === "reset") this.core.resetWorld();
			else if (message.type === "predict") this.core.predictBlock(message.x, message.y, message.z, message.block);
			else {
				this.core.packet(message.data);
				if (message.data[0] === 1 && message.generation !== undefined) {
					this.core.lightGeneration(...packetCoords(message.data), message.generation);
				}
			}
		}
		this.wake();
	}
	private wake(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		this.schedule(() => {
			this.scheduled = false;
			this.core.stepLight(this.x, this.z);
			this.send({ type: "light", sequence: this.sequence, pending: this.core.lightPending, updates: this.core.takeLightUpdates() });
			if (this.core.lightPending) this.wake();
		});
	}
}
