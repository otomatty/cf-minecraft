import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bounded, diagnose, processCpuDeltas, safeFilename, shouldDiagnoseRunFailure, summarizeTargets, watchForCrash } from "./e2e-diag.mjs";

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

test("Puppeteer timeout names and messages are recognized directly and through causes", () => {
	const named = new Error("selector was not found");
	named.name = "TimeoutError";
	for (const timeout of [
		named,
		new Error("Navigation timeout of 30000 ms exceeded"),
		new Error("Waiting failed: 15000ms exceeded"),
		new Error("Runtime.callFunctionOn timed out"),
	]) {
		assert.equal(shouldDiagnoseRunFailure(timeout), true);
		const wrapped = new Error("stage failed", { cause: new Error("operation failed", { cause: timeout }) });
		assert.equal(shouldDiagnoseRunFailure(wrapped), true);
		wrapped.diagnosed = true;
		assert.equal(shouldDiagnoseRunFailure(wrapped), false);
		timeout.diagnosed = true;
		assert.equal(shouldDiagnoseRunFailure(timeout), false);
		assert.equal(shouldDiagnoseRunFailure(new Error("stage failed", { cause: timeout })), false);
	}
	assert.equal(shouldDiagnoseRunFailure(new Error("stage failed", { cause: new Error("connection closed") })), false);
});

test("timeout cause inspection stops after five errors and handles cycles", () => {
	let err = new Error("Waiting failed: 15000ms exceeded");
	for (let i = 0; i < 4; i++) err = new Error("wrapped", { cause: err });
	assert.equal(shouldDiagnoseRunFailure(err), true);
	assert.equal(shouldDiagnoseRunFailure(new Error("too deep", { cause: err })), false);
	const cycle = new Error("failed");
	cycle.cause = cycle;
	assert.equal(shouldDiagnoseRunFailure(cycle), false);
	assert.equal(shouldDiagnoseRunFailure(null), false);
});

test("diagnostic screenshots use CDP command deadlines and detach on success or failure", async (t) => {
	const shots = await mkdtemp(join(tmpdir(), "e2e-diag-test-"));
	t.mock.method(console, "log", () => {});
	try {
		for (const fails of [false, true]) {
			let detached = 0;
			let closed = 0;
			const session = {
				async send(...args) {
					assert.deepEqual(args, ["Page.captureScreenshot", { format: "png" }, { timeout: 5000 }]);
					if (fails) throw new Error("Page.captureScreenshot timed out");
					return { data: Buffer.from("test png bytes").toString("base64") };
				},
				async detach() { detached++; },
			};
			const page = {
				async evaluate() { return { readyState: "complete" }; },
				target() { return { async createCDPSession() { return session; } }; },
				async screenshot() { assert.fail("Puppeteer screenshot lock must not be used"); },
			};
			const browser = {
				// Skip browser-level CPU sampling to keep this mock-based test fast.
				target() { return { async createCDPSession() { throw new Error("browser CDP unavailable"); } }; },
				async newPage() {
					return { async goto() {}, async evaluate() { return "complete"; }, async close() { closed++; } };
				},
			};
			const label = fails ? "capture-failure" : "capture-success";
			const result = await diagnose(browser, page, label, { edge: "http://localhost", shots });
			assert.equal(result.crashed, false);
			assert.equal(detached, 1);
			assert.equal(closed, 1);
			assert.equal(result.screenshotSessionDetach, "detached");
			if (fails) {
				assert.equal(result.screenshot, "Page.captureScreenshot timed out");
			} else {
				assert.equal(result.screenshot, join(shots, `diag-${label}.png`));
				assert.equal(await readFile(result.screenshot, "utf8"), "test png bytes");
			}
			assert.deepEqual(JSON.parse(await readFile(join(shots, `diag-${label}.json`), "utf8")), result);
		}
	} finally {
		await rm(shots, { recursive: true, force: true });
	}
});

test("diagnostic capture and screenshot session detach finish before opening a fresh tab", async (t) => {
	const shots = await mkdtemp(join(tmpdir(), "e2e-diag-order-"));
	t.mock.method(console, "log", () => {});
	const calls = [];
	const page = {
		async evaluate() { calls.push("page evaluate"); return { readyState: "complete" }; },
		target() {
			return {
				async createCDPSession() {
					calls.push("screenshot session");
					return {
						async send(method) {
							assert.equal(method, "Page.captureScreenshot");
							calls.push("capture");
							return { data: Buffer.from("captured before focus change").toString("base64") };
						},
						async detach() { calls.push("screenshot detach"); },
					};
				},
			};
		},
	};
	const browser = {
		target() {
			return { async createCDPSession() {
				calls.push("browser session");
				throw new Error("browser CDP unavailable");
			} };
		},
		async newPage() {
			calls.push("new tab");
			return {
				async goto() { calls.push("fresh goto"); },
				async evaluate() { calls.push("fresh evaluate"); return "complete"; },
				async close() { calls.push("fresh close"); },
			};
		},
	};
	try {
		const result = await diagnose(browser, page, "capture-order", { edge: "http://localhost", shots });
		assert.deepEqual(calls, [
			"page evaluate", "browser session", "screenshot session", "capture", "screenshot detach",
			"new tab", "fresh goto", "fresh evaluate", "fresh close",
		]);
		assert.equal(await readFile(result.screenshot, "utf8"), "captured before focus change");
		assert.equal(result.screenshotSessionDetach, "detached");
		assert.equal(result.freshTabClose, "closed");
	} finally {
		await rm(shots, { recursive: true, force: true });
	}
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

test("diagnostics record a renderer crash from page error and Inspector.targetCrashed", async (t) => {
	const shots = await mkdtemp(join(tmpdir(), "e2e-diag-crash-"));
	const lines = [];
	t.mock.method(console, "log", (...args) => lines.push(args.join(" ")));
	const handlers = {};
	const notes = [];
	const session = {
		async send(method) {
			if (method === "Inspector.enable") return;
			if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
			throw new Error(method);
		},
		on(event, cb) { handlers[event] = cb; },
		async detach() {},
	};
	const page = {
		on(event, cb) { handlers[event] = cb; },
		target() { return { async createCDPSession() { return session; } }; },
		async evaluate() { throw new Error("Target crashed"); },
	};
	const browser = {
		target() { return { async createCDPSession() { throw new Error("browser CDP unavailable"); } }; },
		async newPage() {
			return { async goto() {}, async evaluate() { return "complete"; }, async close() {} };
		},
	};
	try {
		await watchForCrash(page, (message) => notes.push(message));
		handlers.error(new Error("Aw, Snap!"));
		handlers["Inspector.targetCrashed"]({});
		assert.deepEqual(notes, ["page error: Aw, Snap!", "Inspector.targetCrashed"]);
		const result = await diagnose(browser, page, "renderer crash", { edge: "http://localhost", shots });
		assert.equal(result.crashed, true);
		assert.equal(result.page, "Target crashed");
		assert.deepEqual(result.crash, { pageErrors: ["Aw, Snap!"], targetCrashed: [{}] });
		assert.match(lines.join("\n"), /DIAG renderer crash .*"crashed":true/);
		const saved = JSON.parse(await readFile(join(shots, "diag-renderer-crash.json"), "utf8"));
		assert.equal(saved.crashed, true);
		assert.deepEqual(saved.crash.pageErrors, ["Aw, Snap!"]);
		assert.deepEqual(saved.crash.targetCrashed, [{}]);
	} finally {
		await rm(shots, { recursive: true, force: true });
	}
});

test("diagnostics include a renderer crash reported while collecting fresh-tab state", async (t) => {
	const shots = await mkdtemp(join(tmpdir(), "e2e-diag-late-crash-"));
	t.mock.method(console, "log", () => {});
	const handlers = {};
	const session = {
		async send(method) {
			if (method === "Inspector.enable") return;
			throw new Error("screenshot unavailable");
		},
		on(event, cb) { handlers[event] = cb; },
		async detach() {},
	};
	const page = {
		on(event, cb) { handlers[event] = cb; },
		target() { return { async createCDPSession() { return session; } }; },
		async evaluate() { return { readyState: "complete" }; },
	};
	const browser = {
		target() { return { async createCDPSession() { throw new Error("browser CDP unavailable"); } }; },
		async newPage() {
			return {
				async goto() {},
				async evaluate() {
					handlers.error(new Error("Aw, Snap!"));
					handlers["Inspector.targetCrashed"]({ status: "crashed" });
					return "complete";
				},
				async close() {},
			};
		},
	};
	try {
		await watchForCrash(page);
		const result = await diagnose(browser, page, "late crash", { edge: "http://localhost", shots });
		assert.deepEqual(result.page, { readyState: "complete" });
		assert.equal(result.crashed, true);
		assert.deepEqual(result.crash, { pageErrors: ["Aw, Snap!"], targetCrashed: [{ status: "crashed" }] });
		assert.deepEqual(JSON.parse(await readFile(join(shots, "diag-late-crash.json"), "utf8")), result);
	} finally {
		await rm(shots, { recursive: true, force: true });
	}
});
