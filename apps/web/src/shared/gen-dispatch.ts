/** Host-independent bridge. Only pump mutates the server; callbacks queue results. */
export interface GenerationTarget {
	takeGenerationRequests(): Array<[number, number]>;
	deliverGenerated(cx: number, cz: number, bytes: Uint8Array): boolean;
	generateNow(cx: number, cz: number): void;
}

export interface GenerationStats {
	requested: number;
	delivered: number;
	fallback: number;
	queued: number;
	inFlight: number;
	latencyMean: number;
	latencyMax: number;
}

type Job = { cx: number; cz: number; started: number; done: boolean; bytes?: Uint8Array };

export class GenerationDispatcher {
	private epoch = 0;
	private failure = false;
	private queue: Array<[number, number]> = [];
	private active = new Set<Job>();
	private completed: Job[] = [];
	private durations: number[] = [];
	private requested = 0;
	private delivered = 0;
	private fallback = 0;

	private readonly request: (cx: number, cz: number) => Promise<Uint8Array>;
	private readonly limit: number;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(
		request: (cx: number, cz: number) => Promise<Uint8Array>,
		limit: number,
		timeoutMs: number,
		now: () => number = () => performance.now(),
	) {
		if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid generation limits");
		this.request = request;
		this.limit = limit;
		this.timeoutMs = timeoutMs;
		this.now = now;
	}

	pump(core: GenerationTarget): void {
		// A timed-out request still runs at the destination. Never reuse its slot.
		for (const job of this.active) {
			if (!job.done && this.now() - job.started >= this.timeoutMs) this.failure = true;
		}
		if (this.failure) {
			for (const job of this.active) {
				if (!job.done) this.recordDuration(this.now() - job.started);
				core.generateNow(job.cx, job.cz);
				this.fallback++;
			}
			this.active.clear();
			this.completed = [];
			this.queue.push(...core.takeGenerationRequests());
			for (const [cx, cz] of this.queue.splice(0)) {
				core.generateNow(cx, cz);
				this.fallback++;
			}
			return;
		}
		const completed = this.completed.splice(0);
		for (const job of completed) {
			this.active.delete(job);
			if (!job.bytes) continue;
			if (core.deliverGenerated(job.cx, job.cz, job.bytes)) this.delivered++;
			else this.fallback++; // The core replaces malformed bytes synchronously.
		}
		for (const job of completed) {
			if (job.bytes) continue;
			core.generateNow(job.cx, job.cz);
			this.fallback++;
		}
		this.queue.push(...core.takeGenerationRequests());
		while (!this.failure && this.active.size < this.limit && this.queue.length) {
			const [cx, cz] = this.queue.shift()!;
			const job: Job = { cx, cz, started: this.now(), done: false };
			const epoch = this.epoch;
			this.active.add(job);
			this.requested++;
			const finish = (bytes?: Uint8Array) => {
				if (epoch !== this.epoch || this.failure || job.done) return;
				job.done = true;
				if (this.now() - job.started >= this.timeoutMs) this.failure = true;
				job.bytes = bytes;
				this.recordDuration(this.now() - job.started);
				this.completed.push(job);
			};
			try { this.request(cx, cz).then(bytes => finish(bytes), () => finish()); }
			catch { finish(); }
		}
	}

	private recordDuration(ms: number): void {
		this.durations.push(ms);
		if (this.durations.length > 100) this.durations.shift();
	}

	get failed(): boolean {
		return this.failure;
	}

	reset(): void {
		this.epoch++;
		this.failure = false;
		this.queue = [];
		this.active.clear();
		this.completed = [];
		this.durations = [];
		this.requested = this.delivered = this.fallback = 0;
	}

	stats(): GenerationStats {
		return {
			requested: this.requested, delivered: this.delivered, fallback: this.fallback,
			queued: this.queue.length, inFlight: this.active.size,
			latencyMean: this.durations.length ? this.durations.reduce((a, b) => a + b, 0) / this.durations.length : 0,
			latencyMax: Math.max(0, ...this.durations),
		};
	}
}
