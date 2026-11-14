import assert from "node:assert/strict";
import { test } from "node:test";
import { MeshPool, meshWorkerCount, MAX_MESH_WORKERS, MAX_MESH_REQUESTS_PER_WORKER, MESH_FRAME_BUDGET_MS, MESH_REFILL_BUDGET_MS, MESH_APPLY_BUDGET_MS, MAX_BUFFERED_MESHES } from "./mesh-pool.ts";

class FakeWorker {
	onmessage = null;
	onerror = null;
	onmessageerror = null;
	jobs = [];
	terminated = false;
	postMessage(job, transfer) {
		assert.deepEqual(transfer, [job.padded.buffer]);
		this.jobs.push(structuredClone(job, { transfer }));
		assert.equal(job.padded.byteLength, 0);
	}
	terminate() { this.terminated = true; }
	ready() { this.onmessage({ data: { type: "ready" } }); }
	finish(index = this.jobs.length - 1) {
		this.onmessage({ data: { type: "mesh", id: this.jobs[index].id, vertices: new Uint32Array([42]) } });
	}
}
function fixture(t, count = 2) {
	const workers = [], applied = [], requeued = [];
	const clock = { now: 0, popCost: 0, paddedCost: 0, uploadCost: 0 };
	t.mock.method(performance, "now", () => clock.now);
	let current = true;
	const pool = new MeshPool(count, () => {
		const worker = new FakeWorker(); workers.push(worker); return worker;
	}, (section, vertices) => { clock.now += clock.uploadCost; applied.push([section, [...vertices]]); }, section => requeued.push(section), () => current);
	t.after(() => { pool.reset(); workers[0]?.onerror({}); });
	const pump = queue => pool.pump(() => {
		clock.now += clock.popCost;
		return queue.shift() ?? null;
	}, () => {
		clock.now += clock.paddedCost;
		return new Uint16Array([1]);
	});
	return { pool, workers, applied, requeued, pump, clock, current: value => { current = value; } };
}

test("worker count is bounded and reserves a core when available", () => {
	assert.deepEqual([0, 1, 2, 4, 128].map(meshWorkerCount), [1, 1, 1, 3, MAX_MESH_WORKERS]);
});

test("nearest-first source order, multiple in flight per worker, bounded queues and transfers", t => {
	const f = fixture(t, 100);
	const queue = Array.from({ length: 80 }, (_, i) => [i, 0, 0]);
	f.pump(queue); // Initializing workers must not consume dirty work.
	assert.equal(queue.length, 80);
	f.workers.forEach(w => w.ready());
	f.pump(queue);
	const capacity = MAX_MESH_WORKERS * MAX_MESH_REQUESTS_PER_WORKER;
	assert.equal(f.pool.workerCount, MAX_MESH_WORKERS);
	assert.equal(f.pool.inFlight, capacity);
	assert.ok(f.workers.every(w => w.jobs.length === MAX_MESH_REQUESTS_PER_WORKER));
	const dispatched = f.workers.flatMap(w => w.jobs).sort((a, b) => a.id - b.id);
	assert.deepEqual(dispatched.map(j => j.section), Array.from({ length: capacity }, (_, i) => [i, 0, 0]));
	f.pump(queue);
	assert.equal(queue.length, 80 - capacity);
	const completed = f.workers[0].jobs[0];
	f.workers[0].finish(0); // Refill without waiting for another frame.
	assert.equal(queue.length, 79 - capacity);
	assert.equal(f.pool.inFlight, capacity);
	assert.deepEqual(f.workers[0].jobs.at(-1).section, [capacity, 0, 0]);
	assert.deepEqual(f.applied, []);
	assert.equal(f.pool.pendingResults, 1);
	f.pool.applyResults();
	assert.deepEqual(f.applied, [[completed.section, [42]]]);
});

test("frame and reply refills stop at their time budgets, including dirty selection and copies", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	const queue = Array.from({ length: 40 }, (_, i) => [i, 0, 0]);
	f.clock.popCost = 0.25;
	f.clock.paddedCost = 0.25;
	f.pump(queue);
	assert.equal(f.workers[0].jobs.length, MESH_FRAME_BUDGET_MS / 0.5);
	assert.equal(f.pool.takeMainThreadMs(), MESH_FRAME_BUDGET_MS);
	f.clock.uploadCost = 3;
	f.workers[0].finish(0);
	assert.equal(f.workers[0].jobs.length, (MESH_FRAME_BUDGET_MS + MESH_REFILL_BUDGET_MS) / 0.5);
	assert.equal(f.pool.inFlight, f.workers[0].jobs.length - 1);
	assert.equal(f.pool.takeMainThreadMs(), MESH_REFILL_BUDGET_MS);
	assert.deepEqual(f.applied, []);
	f.pool.applyResults();
	assert.equal(f.pool.takeMainThreadMs(), 3);
	assert.equal(f.pool.takeMainThreadMs(), 0); // A frame drains the reply/upload time exactly once.
});

test("one indivisible copy can exceed a budget, but no further request starts", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.clock.paddedCost = 3;
	f.pump([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
	assert.equal(f.workers[0].jobs.length, 1);
	assert.equal(f.pool.takeMainThreadMs(), 3);
	f.workers[0].finish(0);
	assert.equal(f.workers[0].jobs.length, 2);
	assert.equal(f.pool.takeMainThreadMs(), 3);
});

test("reply refill uses the source most recently registered by a frame", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	const oldQueue = Array.from({ length: 20 }, (_, i) => [i, 0, 0]);
	f.pump(oldQueue);
	const newQueue = [[100, 0, 0], [101, 0, 0]];
	f.pump(newQueue); // Full worker: register the new camera priority without consuming it.
	assert.equal(newQueue.length, 2);
	f.workers[0].finish(0);
	assert.deepEqual(f.workers[0].jobs.at(-1).section, [100, 0, 0]);
	assert.equal(oldQueue.length, 12);
});

test("newer request wins even when the older result arrives last", t => {
	const f = fixture(t);
	f.workers.forEach(w => w.ready());
	f.pump([[1, 2, 3]]);
	f.pump([[1, 2, 3]]);
	f.workers[1].finish();
	f.workers[0].finish();
	f.pool.applyResults();
	assert.deepEqual(f.applied, [[[1, 2, 3], [42]]]);
	assert.equal(f.pool.inFlight, 0);
});

test("dirty changes waiting in the world invalidate an in-flight result", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[1, 2, 3]]);
	f.current(false);
	f.workers[0].finish();
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
});

test("unload and reload at the same coordinates discard the old generation", t => {
	const f = fixture(t);
	f.workers.forEach(w => w.ready());
	f.pump([[1, 2, 3]]);
	f.pool.invalidateChunk(1, 3);
	f.pump([[1, 2, 3]]);
	f.workers[0].finish();
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
	f.workers[1].finish();
	f.pool.applyResults();
	assert.equal(f.applied.length, 1);
});

test("reset discards all queued results and disables refill from the old world", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	const queue = Array.from({ length: 12 }, (_, i) => [i, 0, 0]);
	f.pump(queue);
	assert.equal(f.pool.inFlight, MAX_MESH_REQUESTS_PER_WORKER);
	f.pool.reset();
	for (let i = 0; i < MAX_MESH_REQUESTS_PER_WORKER; i++) f.workers[0].finish(i);
	assert.equal(f.pool.inFlight, 0);
	assert.equal(queue.length, 12 - MAX_MESH_REQUESTS_PER_WORKER);
	assert.equal(f.workers[0].jobs.length, MAX_MESH_REQUESTS_PER_WORKER);
	assert.deepEqual(f.applied, []);
});

test("discarding an unloaded result still refills the available slot", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	const queue = Array.from({ length: 12 }, (_, i) => [i, 0, 0]);
	f.pump(queue);
	f.pool.invalidateChunk(0, 0);
	f.workers[0].finish(0);
	assert.deepEqual(f.applied, []);
	assert.equal(f.pool.inFlight, MAX_MESH_REQUESTS_PER_WORKER);
	assert.deepEqual(f.workers[0].jobs.at(-1).section, [MAX_MESH_REQUESTS_PER_WORKER, 0, 0]);
});

test("worker failure requeues valid work and terminates the pool for fallback", t => {
	const f = fixture(t);
	f.workers.forEach(w => w.ready());
	f.pump([[1, 2, 3], [4, 5, 6], [7, 8, 9], [4, 5, 6], [1, 4, 3], [10, 11, 12]]);
	assert.equal(f.pool.inFlight, 6);
	f.pool.invalidateChunk(1, 3);
	f.workers[0].onerror({});
	assert.deepEqual(f.requeued.sort(), [[4, 5, 6], [7, 8, 9], [10, 11, 12]].sort());
	assert.equal(f.pool.inFlight, 0);
	assert.equal(f.pool.useFallback, true);
	assert.equal(f.pool.workerCount, 0);
	assert.ok(f.workers.every(w => w.terminated));
	f.workers[1].finish();
	assert.deepEqual(f.applied, []);
});

test("construction errors and initialization timeout select fallback", t => {
	const pool = new MeshPool(1, () => { throw new Error("unavailable"); }, () => {}, () => {}, () => true);
	assert.equal(pool.useFallback, true);
	let timeout;
	t.mock.method(globalThis, "setTimeout", callback => { timeout = callback; return 1; });
	t.mock.method(globalThis, "clearTimeout", () => {});
	const f = fixture(t);
	timeout();
	assert.equal(f.pool.useFallback, true);
	assert.ok(f.workers.every(w => w.terminated));
});

test("postMessage failure requeues the consumed section", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.workers[0].postMessage = () => { throw new Error("transfer failed"); };
	f.pump([[1, 2, 3]]);
	assert.equal(f.pool.useFallback, true);
	assert.deepEqual(f.requeued, [[1, 2, 3]]);
});


test("a burst of replies only queues results; each frame uploads within its budget in FIFO order", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump(Array.from({ length: 8 }, (_, i) => [i, 0, 0]));
	f.clock.uploadCost = 1;
	for (let i = 0; i < 8; i++) f.workers[0].finish(i);
	assert.deepEqual(f.applied, []);
	assert.equal(f.pool.inFlight, 0);
	assert.equal(f.pool.pendingResults, 8); // meshQueue must stay nonzero until uploads finish.
	assert.equal(f.pool.takeMainThreadMs(), 0);
	f.pool.applyResults();
	assert.equal(f.applied.length, MESH_APPLY_BUDGET_MS);
	assert.equal(f.pool.pendingResults, 8 - MESH_APPLY_BUDGET_MS);
	assert.equal(f.pool.takeMainThreadMs(), MESH_APPLY_BUDGET_MS);
	f.pool.applyResults();
	f.pool.applyResults();
	assert.equal(f.pool.pendingResults, 0);
	assert.deepEqual(f.applied.map(([section]) => section), Array.from({ length: 8 }, (_, i) => [i, 0, 0]));
});

test("an indivisible upload can overrun the budget but no second upload starts", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[0, 0, 0], [1, 0, 0]]);
	f.workers[0].finish(0);
	f.workers[0].finish(1);
	f.clock.uploadCost = MESH_APPLY_BUDGET_MS + 1;
	f.pool.applyResults();
	assert.equal(f.applied.length, 1);
	assert.equal(f.pool.pendingResults, 1);
	assert.equal(f.pool.takeMainThreadMs(), MESH_APPLY_BUDGET_MS + 1);
});

test("a newer request invalidates a result already waiting for upload", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[1, 2, 3]]);
	f.workers[0].finish(0);
	f.pump([[1, 2, 3]]);
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
	f.workers[0].finish(1);
	f.pool.applyResults();
	assert.equal(f.applied.length, 1);
});

test("dirty state is checked at upload time, after receipt", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[1, 2, 3]]);
	f.workers[0].finish();
	assert.equal(f.pool.pendingResults, 1);
	f.current(false);
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
	assert.equal(f.pool.pendingResults, 0);
});

test("unload and reload invalidate an already received result at the same coordinates", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[1, 2, 3]]);
	f.workers[0].finish(0);
	f.pool.invalidateChunk(1, 3);
	f.pump([[1, 2, 3]]);
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
	f.workers[0].finish(1);
	f.pool.applyResults();
	assert.equal(f.applied.length, 1);
});

test("reset clears received results and failure requeues results awaiting upload", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	f.pump([[1, 2, 3]]);
	f.workers[0].finish(0);
	f.pool.reset();
	assert.equal(f.pool.pendingResults, 0);
	f.pool.applyResults();
	assert.deepEqual(f.applied, []);
	f.pump([[4, 5, 6], [7, 8, 9]]);
	f.workers[0].finish(1);
	f.workers[0].onerror({});
	assert.deepEqual(f.requeued.sort(), [[4, 5, 6], [7, 8, 9]].sort());
	assert.equal(f.pool.pendingResults, 0);
	assert.equal(f.pool.useFallback, true);
});

test("buffering is bounded when workers outpace uploads and resumes after a frame drains results", t => {
	const f = fixture(t, 1);
	f.workers[0].ready();
	const queue = Array.from({ length: MAX_BUFFERED_MESHES + 20 }, (_, i) => [i, 0, 0]);
	f.pump(queue);
	for (let i = 0; i < MAX_BUFFERED_MESHES; i++) f.workers[0].finish(i);
	assert.equal(f.pool.pendingResults, MAX_BUFFERED_MESHES);
	assert.equal(f.pool.inFlight, 0);
	assert.equal(queue.length, 20);
	f.pump(queue);
	assert.equal(queue.length, 20);
	f.clock.uploadCost = 1;
	f.pool.applyResults();
	f.pump(queue);
	assert.equal(queue.length, 20 - MESH_APPLY_BUDGET_MS);
	assert.equal(f.pool.pendingResults + f.pool.inFlight, MAX_BUFFERED_MESHES);
});
