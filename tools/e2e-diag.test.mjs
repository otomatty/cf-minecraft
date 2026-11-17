import assert from "node:assert/strict";
import test from "node:test";
import { bounded, processCpuDeltas, safeFilename, shouldDiagnoseRunFailure, summarizeTargets } from "./e2e-diag.mjs";

test("run failures are diagnosed only for unmarked timeout messages", () => {
	assert.equal(shouldDiagnoseRunFailure(new Error("Runtime.callFunctionOn timed out")), true);
	assert.equal(shouldDiagnoseRunFailure(new Error("Navigation TIMED OUT")), true);
	assert.equal(shouldDiagnoseRunFailure(new Error("world did not settle")), false);
	const diagnosed = new Error('world did not settle: failed {"targets":"timed out after 3000ms"}');
	diagnosed.diagnosed = true;
	assert.equal(shouldDiagnoseRunFailure(diagnosed), false);
	const diagnosedTimeout = new Error("Runtime.callFunctionOn timed out");
	diagnosedTimeout.diagnosed = true;
	assert.equal(shouldDiagnoseRunFailure(diagnosedTimeout), false);
	const detailOnly = new Error("navigation failed");
	detailOnly.diagnostics = { targets: "timed out after 3000ms" };
	assert.equal(shouldDiagnoseRunFailure(detailOnly), false);
});

test("targets are grouped by type and final URL component without query", () => {
	assert.deepEqual(summarizeTargets([
		{ type: "worker", url: "http://localhost/assets/worker.js?v=1" },
		{ type: "worker", url: "http://localhost/assets/worker.js?v=2" },
		{ type: "page", url: "http://localhost/play.html?mode=creative" },
		{ type: "worker", url: "http://localhost/play.html?mode=creative" },
		{ type: "page", url: "http://localhost/" },
		{ type: "page", url: "about:blank" },
	]), { "worker: worker.js": 2, "page: play.html": 1, "worker: play.html": 1, "page: /": 1, "page: about:blank": 1 });
	assert.deepEqual(summarizeTargets([]), {});
});

test("CPU deltas sum matching processes by type, excluding new, gone and reset processes", () => {
	const before = [
		{ id: 1, type: "browser", cpuTime: 10 },
		{ id: 2, type: "renderer", cpuTime: 20 },
		{ id: 3, type: "renderer", cpuTime: 30 },
		{ id: 4, type: "GPU", cpuTime: 5 },
		{ id: 5, type: "renderer", cpuTime: 100 },
		{ id: 6, type: "renderer", cpuTime: 10 },
	];
	const after = [
		{ id: 1, type: "browser", cpuTime: 10.5 },
		{ id: 2, type: "renderer", cpuTime: 22 },
		{ id: 3, type: "renderer", cpuTime: 30 },
		{ id: 4, type: "GPU", cpuTime: 6.5 },
		{ id: 6, type: "renderer", cpuTime: 1 },
		{ id: 7, type: "renderer", cpuTime: 50 },
		{ id: 5, type: "utility", cpuTime: 101 },
	];
	assert.deepEqual(processCpuDeltas(before, after), {
		browser: { count: 1, sampled: 1, cpuTimeDelta: 0.5 },
		renderer: { count: 4, sampled: 2, cpuTimeDelta: 2 },
		GPU: { count: 1, sampled: 1, cpuTimeDelta: 1.5 },
		utility: { count: 1, sampled: 0, cpuTimeDelta: 0 },
	});
	assert.deepEqual(processCpuDeltas([], []), {});
});

test("filenames keep readable labels and cannot escape the shots directory", () => {
	assert.equal(safeFilename("survival reload"), "survival-reload");
	assert.equal(safeFilename("../../foo\\bar?x=1\n"), "foo-bar-x-1");
	assert.equal(safeFilename("../日本語/.."), "diagnostic");
	assert.equal(safeFilename("a".repeat(200)).length, 100);
	assert.equal(safeFilename("sky-6000_ok"), "sky-6000_ok");
});

test("bounded returns values, rejection messages and synchronous exceptions", async () => {
	assert.equal(await bounded(() => 42, 1000), 42);
	assert.deepEqual(await bounded(async () => ({ ready: true }), 1000), { ready: true });
	assert.equal(await bounded(() => { throw new Error("sync failure"); }, 1000), "sync failure");
	assert.equal(await bounded(async () => { throw new Error("async failure"); }, 1000), "async failure");
	assert.equal(await bounded(() => Promise.reject("string failure"), 1000), "string failure");
});

test("bounded returns the default or selected deadline value for a hung operation", async () => {
	assert.equal(await bounded(() => new Promise(() => {}), 5), "timed out after 5ms");
	assert.equal(await bounded(() => new Promise(() => {}), 5, "no response"), "no response");
});

test("late rejection after a deadline is still handled", async () => {
	let reject;
	assert.equal(await bounded(() => new Promise((_, fail) => { reject = fail; }), 5), "timed out after 5ms");
	reject(new Error("late rejection"));
	await new Promise(resolve => setImmediate(resolve));
});

test("completed and rejected operations clear long deadline timers so Node can exit", async (t) => {
	const schedule = globalThis.setTimeout;
	const clear = globalThis.clearTimeout;
	const pending = new Set();
	t.mock.method(globalThis, "setTimeout", (callback, ms) => {
		const timer = schedule(callback, ms);
		pending.add(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearTimeout", timer => {
		pending.delete(timer);
		clear(timer);
	});
	try {
		await bounded(() => 42, 60000);
		assert.equal(pending.size, 0);
		await bounded(() => { throw new Error("failure"); }, 60000);
		assert.equal(pending.size, 0);
		await bounded(() => new Promise(() => {}), 5);
		assert.equal(pending.size, 0);
	} finally {
		for (const timer of pending) clear(timer);
	}
});
