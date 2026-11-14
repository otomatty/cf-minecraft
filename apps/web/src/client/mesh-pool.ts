export type Section = [number, number, number];
export interface MeshRequest {
	id: number;
	section: Section;
	padded: Uint16Array<ArrayBuffer>;
	// #14: optional padded light data can accompany the block data here.
}
export type MeshReply = { type: "ready" } | { type: "mesh"; id: number; vertices: Uint32Array<ArrayBuffer> };
export interface MeshWorker {
	onmessage: ((event: MessageEvent<MeshReply>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(message: MeshRequest, transfer: Transferable[]): void;
	terminate(): void;
}
export const MAX_MESH_WORKERS = 4;
export const MAX_MESH_REQUESTS_PER_WORKER = 8;
export const MESH_FRAME_BUDGET_MS = 2;
export const MESH_REFILL_BUDGET_MS = 1;
export const MESH_APPLY_BUDGET_MS = 3;
// Bound vertices waiting for upload as well as work still held by workers.
export const MAX_BUFFERED_MESHES = MAX_MESH_WORKERS * MAX_MESH_REQUESTS_PER_WORKER * 2;
const INIT_TIMEOUT_MS = 10000;
const key = (s: Section) => s.join(",");

export function meshWorkerCount(concurrency: number): number {
	return Math.max(1, Math.min(MAX_MESH_WORKERS, Math.floor(concurrency || 2) - 1));
}

/** Unsubmitted work stays in the world's camera-sorted dirty set.
 * Workers have bounded queues and refill on replies as well as on frames.
 */
export class MeshPool {
	private slots: { worker: MeshWorker; ready: boolean; jobs: Map<number, MeshRequest> }[] = [];
	private results = new Map<number, { job: MeshRequest; vertices: Uint32Array<ArrayBuffer> }>();
	private latest = new Map<string, number>();
	private serial = 0;
	private pop: (() => Section | null) | undefined;
	private padded: ((section: Section) => Uint16Array<ArrayBuffer>) | undefined;
	private mainThreadMs = 0;
	private failed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly apply: (section: Section, vertices: Uint32Array) => void;
	private readonly requeue: (section: Section) => void;
	private readonly current: (section: Section) => boolean;

	constructor(count: number, create: () => MeshWorker,
		apply: (section: Section, vertices: Uint32Array) => void,
		requeue: (section: Section) => void, current: (section: Section) => boolean) {
		this.apply = apply;
		this.requeue = requeue;
		this.current = current;
		try {
			for (let i = 0; i < Math.min(MAX_MESH_WORKERS, count); i++) {
				const worker = create();
				const slot = { worker, ready: false, jobs: new Map<number, MeshRequest>() };
				this.slots.push(slot);
				worker.onerror = worker.onmessageerror = () => this.fallback();
				worker.onmessage = ({ data }) => {
					const start = performance.now();
					try {
						if (this.failed) return;
						if (data.type === "ready") {
							slot.ready = true;
							if (this.slots.every(s => s.ready)) clearTimeout(this.timer);
						} else {
							const job = slot.jobs.get(data.id);
							if (!job) return;
							slot.jobs.delete(data.id);
							// Upload and world validation happen only in the frame loop.
							if (this.latest.get(key(job.section)) === job.id) {
								this.results.set(job.id, { job, vertices: data.vertices });
							}
						}
						this.refill(MESH_REFILL_BUDGET_MS);
					} finally {
						this.mainThreadMs += performance.now() - start;
					}
				};
			}
			if (!this.slots.length) this.fallback();
			else this.timer = setTimeout(() => this.fallback(), INIT_TIMEOUT_MS);
		} catch {
			this.fallback();
		}
	}

	get workerCount(): number { return this.slots.length; }
	get inFlight(): number { return this.slots.reduce((total, slot) => total + slot.jobs.size, 0); }
	get pendingResults(): number { return this.results.size; }
	get useFallback(): boolean { return this.failed; }

	private fallback(): void {
		this.failed = true;
		clearTimeout(this.timer);
		for (const { worker, jobs } of this.slots) {
			worker.terminate();
			for (const job of jobs.values()) {
				if (this.latest.get(key(job.section)) === job.id) this.requeue(job.section);
			}
		}
		for (const { job } of this.results.values()) {
			if (this.latest.get(key(job.section)) === job.id) this.requeue(job.section);
		}
		this.slots = [];
		this.results.clear();
		this.latest.clear();
	}

	invalidateChunk(cx: number, cz: number): void {
		for (const { job } of this.results.values()) {
			if (job.section[0] === cx && job.section[2] === cz) this.latest.delete(key(job.section));
		}
		for (const { jobs } of this.slots) {
			for (const job of jobs.values()) {
				if (job.section[0] === cx && job.section[2] === cz) this.latest.delete(key(job.section));
			}
		}
	}

	reset(): void {
		this.results.clear();
		this.latest.clear();
		this.pop = undefined;
		this.padded = undefined;
	}

	/** Drain once per animation frame, including reply handling since the last frame. */
	takeMainThreadMs(): number {
		const elapsed = this.mainThreadMs;
		this.mainThreadMs = 0;
		return elapsed;
	}

	/** Register the latest camera-aware source, then fill workers within the frame budget. */
	pump(pop: () => Section | null, padded: (section: Section) => Uint16Array<ArrayBuffer>): void {
		this.pop = pop;
		this.padded = padded;
		const start = performance.now();
		try {
			this.refill(MESH_FRAME_BUDGET_MS);
		} finally {
			this.mainThreadMs += performance.now() - start;
		}
	}

	/** FIFO gives every result a turn; bounded buffering prevents distant old work accumulating. */
	applyResults(): void {
		const start = performance.now();
		try {
			// One GPU upload is indivisible and may finish past the deadline.
			while (this.results.size && performance.now() - start < MESH_APPLY_BUDGET_MS) {
				const [id, { job, vertices }] = this.results.entries().next().value!;
				this.results.delete(id);
				if (this.latest.get(key(job.section)) !== id) continue;
				this.latest.delete(key(job.section));
				if (this.current(job.section)) this.apply(job.section, vertices);
			}
		} finally {
			this.mainThreadMs += performance.now() - start;
		}
	}

	private refill(budgetMs: number): void {
		if (this.failed || !this.pop || !this.padded) return;
		const start = performance.now();
		// A single selection/copy is indivisible and may finish past the deadline.
		while (performance.now() - start < budgetMs && this.inFlight + this.results.size < MAX_BUFFERED_MESHES) {
			const slot = this.slots.filter(s => s.ready && s.jobs.size < MAX_MESH_REQUESTS_PER_WORKER)
				.reduce<(typeof this.slots)[number] | undefined>((best, s) =>
					!best || s.jobs.size < best.jobs.size ? s : best, undefined);
			if (!slot) break;
			const section = this.pop();
			if (!section) break;
			const job = { id: ++this.serial, section, padded: this.padded(section) };
			slot.jobs.set(job.id, job);
			this.latest.set(key(section), job.id);
			try {
				slot.worker.postMessage(job, [job.padded.buffer]);
			} catch {
				this.fallback();
				return;
			}
		}
	}
}
