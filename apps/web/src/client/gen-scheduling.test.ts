import assert from "node:assert/strict";
import { test } from "node:test";
import { generationInFlightLimit, leastPendingWorker } from "./gen-scheduling.ts";

test("queues multiple requests per worker and balances by pending count with stable ties", () => {
	const queues = [new Map<number, boolean>(), new Map<number, boolean>()];
	const assigned: number[] = [];
	for (let id = 0; id < 8; id++) {
		const worker = leastPendingWorker(queues);
		assigned.push(worker);
		queues[worker].set(id, true);
	}
	assert.deepEqual(assigned, [0, 1, 0, 1, 0, 1, 0, 1]);
	assert.deepEqual(queues.map(q => q.size), [4, 4]);
	// Out-of-order replies free the matching IDs, leaving other requests pending.
	queues[1].delete(7);
	queues[1].delete(3);
	assert.equal(leastPendingWorker(queues), 1);
	queues[1].set(8, true);
	assert.equal(leastPendingWorker(queues), 1);
	queues[1].set(9, true);
	assert.equal(leastPendingWorker(queues), 0);
});

test("one worker accepts the minimum window; larger pools have a bounded window", () => {
	assert.equal(leastPendingWorker([new Map([[1, true], [2, true]])]), 0);
	for (const [workers, limit] of [[1, 8], [2, 8], [3, 12], [4, 16], [8, 32], [16, 32]]) {
		assert.equal(generationInFlightLimit(workers), limit);
	}
});
