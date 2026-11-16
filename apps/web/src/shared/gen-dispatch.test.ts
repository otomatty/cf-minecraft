import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationDispatcher } from "./gen-dispatch.ts";

function fixture(limit = 2) {
	let now = 0;
	const pending: Array<{ resolve(bytes: Uint8Array): void; reject(error: Error): void }> = [];
	const delivered: number[] = [];
	const fallback: number[] = [];
	const queued: Array<[number, number]> = [[0, 0], [1, 0], [2, 0]];
	const core = {
		takeGenerationRequests: () => queued.splice(0),
		deliverGenerated: (cx: number) => { delivered.push(cx); return true; },
		generateNow: (cx: number) => { fallback.push(cx); },
	};
	const dispatcher = new GenerationDispatcher(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), limit, 100, () => now);
	return { dispatcher, core, pending, delivered, fallback, queued, advance: (ms: number) => { now += ms; } };
}

test("limits requests, queues excess, and delivers next pump in completion FIFO order", async () => {
	const f = fixture();
	f.dispatcher.pump(f.core);
	assert.equal(f.pending.length, 2);
	assert.equal(f.dispatcher.stats().queued, 1);
	f.advance(20);
	f.pending[1].resolve(new Uint8Array([1]));
	await Promise.resolve();
	f.pending[0].resolve(new Uint8Array([0]));
	await Promise.resolve();
	assert.deepEqual(f.delivered, []);
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.delivered, [1, 0]);
	assert.equal(f.pending.length, 3);
	assert.equal(f.dispatcher.stats().delivered, 2);
	assert.equal(f.dispatcher.stats().latencyMean, 20);
	assert.equal(f.dispatcher.stats().latencyMax, 20);
});

test("rejection and timeout fall back once; late replies are ignored", async () => {
	const f = fixture();
	f.dispatcher.pump(f.core);
	f.pending[1].reject(new Error("unavailable"));
	await Promise.resolve();
	f.advance(100);
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.fallback, [0, 1, 2]);
	f.pending[0].resolve(new Uint8Array([0]));
	await Promise.resolve();
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.delivered, []);
	assert.equal(f.dispatcher.stats().fallback, 3);
});

test("reset drops both queued completions and late replies from the old world", async () => {
	const f = fixture();
	f.dispatcher.pump(f.core);
	f.pending[0].resolve(new Uint8Array([0]));
	await Promise.resolve();
	f.dispatcher.reset();
	f.pending[1].resolve(new Uint8Array([1]));
	await Promise.resolve();
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.delivered, []);
	assert.deepEqual(f.fallback, []);
	assert.equal(f.pending.length, 2);
	assert.equal(f.dispatcher.stats().requested, 0);
});

test("synchronous throws also fall back on the next pump", () => {
	const f = fixture();
	const d = new GenerationDispatcher(() => { throw new Error("RPC unavailable"); }, 1, 100);
	d.pump(f.core);
	assert.deepEqual(f.fallback, []);
	d.pump(f.core);
	assert.deepEqual(f.fallback, [0]);
});

test("a pump applies successful completions before synchronous fallbacks", async () => {
	const f = fixture();
	const order: string[] = [];
	f.core.deliverGenerated = (cx: number) => { order.push(`deliver ${cx}`); return true; };
	f.core.generateNow = (cx: number) => { order.push(`fallback ${cx}`); };
	f.dispatcher.pump(f.core);
	f.pending[0].reject(new Error("failed"));
	f.pending[1].resolve(new Uint8Array([1]));
	await Promise.resolve();
	f.dispatcher.pump(f.core);
	assert.deepEqual(order, ["deliver 1", "fallback 0"]);
});


test("timeout stops external requests without reusing slots and falls back all queued jobs", async () => {
	const f = fixture(2);
	f.dispatcher.pump(f.core);
	assert.equal(f.pending.length, 2);
	assert.equal(f.dispatcher.stats().queued, 1);
	f.advance(99);
	f.dispatcher.pump(f.core);
	assert.equal(f.pending.length, 2);
	assert.deepEqual(f.fallback, []);
	f.advance(1);
	f.dispatcher.pump(f.core);
	assert.equal(f.dispatcher.failed, true);
	assert.equal(f.pending.length, 2, "third request never reaches the destination");
	assert.deepEqual(f.fallback, [0, 1, 2]);
	assert.equal(f.dispatcher.stats().queued, 0);
	assert.equal(f.dispatcher.stats().inFlight, 0);
	for (const request of f.pending) request.resolve(new Uint8Array([1]));
	await Promise.resolve();
	f.queued.push([3, 0]);
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.delivered, []);
	assert.deepEqual(f.fallback, [0, 1, 2, 3]);
	assert.equal(f.pending.length, 2, "failed dispatcher never sends more requests");
	f.dispatcher.reset();
	assert.equal(f.dispatcher.failed, false);
	f.queued.push([4, 0]);
	f.dispatcher.pump(f.core);
	assert.equal(f.pending.length, 3, "reset permits generation for a new world");
});

test("a result arriving after its deadline fails the dispatcher even before another pump", async () => {
	const f = fixture();
	f.dispatcher.pump(f.core);
	f.advance(100);
	f.pending[0].resolve(new Uint8Array([0]));
	await Promise.resolve();
	assert.equal(f.dispatcher.failed, true);
	f.dispatcher.pump(f.core);
	assert.deepEqual(f.delivered, []);
	assert.deepEqual(f.fallback, [0, 1, 2]);
	assert.equal(f.pending.length, 2);
});

test("ordinary rejection falls back and frees its slot without failing the destination", async () => {
	const f = fixture();
	f.dispatcher.pump(f.core);
	f.pending[1].reject(new Error("failed"));
	await Promise.resolve();
	f.dispatcher.pump(f.core);
	assert.equal(f.dispatcher.failed, false);
	assert.deepEqual(f.fallback, [1]);
	assert.equal(f.pending.length, 3);
});
