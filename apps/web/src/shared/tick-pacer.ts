// Fixed-rate tick scheduling shared by every host.
//
// Timers are never exact, so the pacer does not count timer callbacks. It
// compares wall-clock time with the number of ticks already run and reports
// how many are due. A late callback is followed by catch-up ticks; when the
// host falls too far behind, the excess is dropped (the game's "Can't keep
// up!" behaviour) instead of spiralling.

export const TICK_MS = 50;

export class TickPacer {
	private epoch: number;
	private done = 0;
	private lastCall: number;
	private readonly tickMs: number;
	private readonly maxCatchUp: number;
	private readonly keep: number;
	skipped = 0;
	/** Wall-clock gaps between the most recent timer callbacks, in ms. */
	readonly gaps: number[] = [];
	/** Ticks run by each of those callbacks. */
	readonly counts: number[] = [];

	constructor(now: number, tickMs: number = TICK_MS, maxCatchUp = 10, keep = 1200) {
		this.epoch = now;
		this.lastCall = now;
		this.tickMs = tickMs;
		this.maxCatchUp = maxCatchUp;
		this.keep = keep;
	}

	/** Number of ticks to run for a timer callback at `now`. */
	due(now: number): number {
		const gap = now - this.lastCall;
		this.lastCall = now;

		let n = Math.floor((now - this.epoch) / this.tickMs) - this.done;
		if (n < 0) n = 0;
		if (n > this.maxCatchUp) {
			const drop = n - this.maxCatchUp;
			this.skipped += drop;
			this.epoch += drop * this.tickMs;
			n = this.maxCatchUp;
		}
		this.done += n;

		this.gaps.push(gap);
		this.counts.push(n);
		if (this.gaps.length > this.keep) {
			this.gaps.shift();
			this.counts.shift();
		}
		return n;
	}

	get ticksRun(): number {
		return this.done;
	}

	/** Ticks per second actually achieved over the sampled window. */
	get measuredTps(): number {
		const ms = this.gaps.reduce((a, b) => a + b, 0);
		if (ms <= 0) return 0;
		const ticks = this.counts.reduce((a, b) => a + b, 0);
		return Math.round((ticks / ms) * 100000) / 100;
	}
}

export interface GapSummary {
	samples: number;
	meanMs: number;
	p50Ms: number;
	p99Ms: number;
	maxMs: number;
}

export function summarize(values: readonly number[]): GapSummary {
	if (values.length === 0) return { samples: 0, meanMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	const round = (v: number) => Math.round(v * 100) / 100;
	return {
		samples: sorted.length,
		meanMs: round(mean),
		p50Ms: round(at(0.5)),
		p99Ms: round(at(0.99)),
		maxMs: round(sorted[sorted.length - 1]),
	};
}
