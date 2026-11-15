import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClientCore } from "./client-core.ts";
import { LightEngine, LightPool, LIGHT_RECORD_BYTES } from "./light-pool.ts";
import { Generator, ServerCore } from "../shared/server-core.ts";

function packet(id, x = 0, z = 0) {
	const bytes = new Uint8Array(9);
	const v = new DataView(bytes.buffer);
	bytes[0] = id; v.setInt32(1, x, false); v.setInt32(5, z, false);
	return bytes;
}
function records(x, z, generation) {
	const bytes = new Uint8Array(LIGHT_RECORD_BYTES);
	const v = new DataView(bytes.buffer);
	v.setInt32(0, x, true); v.setInt32(8, z, true); v.setUint32(12, generation, true);
	return bytes;
}
class Worker {
	onmessage = null; onerror = null; onmessageerror = null;
	messages = []; terminated = false;
	postMessage(message, transfer) { this.messages.push(structuredClone(message, { transfer })); }
	terminate() { this.terminated = true; }
	reply(data) { this.onmessage({ data }); }
	ready() { this.reply({ type: "ready" }); }
}
function fixture(t) {
	const applied = [], generations = [], modes = [];
	const core = { observeLight: undefined, lightPending: 3,
		externalLight: enabled => modes.push(enabled),
		lightGeneration: (...args) => generations.push(args),
		applyLightUpdates: rows => applied.push(...rows),
		stepLight: () => 0.25,
	};
	const worker = new Worker();
	const pool = new LightPool(core, () => worker);
	t.after(() => worker.onerror({}));
	return { core, worker, pool, applied, generations, modes };
}

test("ordered mutations, generations, unload/reset rejection and queue acknowledgements", t => {
	const f = fixture(t);
	f.core.observeLight({ type: "packet", data: packet(1, -1, 2) });
	assert.equal(f.worker.messages.length, 0); // queued until wasm is ready
	assert.equal(f.pool.queue, 1);
	f.worker.ready();
	const first = f.worker.messages[0];
	assert.equal(first.generation, 1);
	f.worker.reply({ type: "light", sequence: 1, pending: 2, updates: records(-1, 2, 1) });
	assert.equal(f.pool.queue, 2);
	assert.equal(f.applied.length, 1);
	f.core.observeLight({ type: "packet", data: packet(2, -1, 2) });
	assert.equal(f.pool.queue, 3); // worker pending + mutation not yet applied
	f.worker.reply({ type: "light", sequence: 1, pending: 1, updates: records(-1, 2, 1) });
	assert.equal(f.applied.length, 1); // unloaded chunk
	assert.equal(f.pool.queue, 2);
	f.core.observeLight({ type: "packet", data: packet(1, -1, 2) });
	assert.equal(f.worker.messages.at(-1).generation, 2);
	f.worker.reply({ type: "light", sequence: 2, pending: 0, updates: records(-1, 2, 1) });
	assert.equal(f.applied.length, 1); // previous lifetime
	assert.equal(f.pool.queue, 1);
	f.worker.reply({ type: "light", sequence: 3, pending: 0, updates: records(-1, 2, 2) });
	assert.equal(f.pool.queue, 0);
	assert.equal(f.applied.length, 2);
	f.core.observeLight({ type: "predict", x: 1, y: 0, z: 2, block: 10 });
	f.core.observeLight({ type: "reset" });
	f.worker.reply({ type: "light", sequence: 4, pending: 0, updates: records(-1, 2, 2) });
	assert.equal(f.applied.length, 2);
	assert.equal(f.pool.queue, 1);
	f.core.observeLight({ type: "packet", data: packet(1, -1, 2) });
	assert.equal(f.worker.messages.at(-1).generation, 3); // reset never reuses generations
	assert.deepEqual(f.worker.messages.map(m => m.type), ["packet", "packet", "packet", "predict", "reset", "packet"]);
	assert.deepEqual(f.generations, [[-1, 2, 1], [-1, 2, 2], [-1, 2, 3]]);
});

test("fallback rebuilds on worker failures and construction failure; timing counts imports", t => {
	const f = fixture(t);
	f.worker.ready();
	f.pool.step(0,0); // discard handshake time before installing a deterministic clock
	let now = 0;
	t.mock.method(performance, "now", () => now);
	f.core.applyLightUpdates = () => { now += 1.5; };
	f.core.observeLight({ type: "packet", data: packet(1) });
	f.worker.reply({ type: "light", sequence: 1, pending: 0, updates: records(0, 0, 1) });
	assert.equal(f.pool.step(0, 0), 1.5);
	f.worker.onerror({});
	assert.equal(f.pool.useFallback, true);
	assert.equal(f.worker.terminated, true);
	assert.equal(f.core.observeLight, undefined);
	assert.equal(f.pool.queue, 3);
	assert.equal(f.pool.step(0, 0), 0.25);
	assert.deepEqual(f.modes, [true, false]);
	const failed = new LightPool(f.core, () => { throw new Error("unavailable"); });
	assert.equal(failed.useFallback, true);
});

test("worker dispatcher yields between slices and processes edits/reset in order", () => {
	const work = [], calls = [], replies = [];
	let pending = 2;
	const core = {
		packet: p => calls.push(["packet", p[0]]),
		lightGeneration: (...args) => calls.push(["generation", ...args]),
		predictBlock: (...args) => calls.push(["predict", ...args]),
		resetWorld: () => { pending = 0; calls.push(["reset"]); },
		stepLight: (x, z) => { pending = Math.max(0, pending - 1); calls.push(["step", x, z]); },
		get lightPending() { return pending; },
		takeLightUpdates: () => new Uint8Array(),
	};
	const engine = new LightEngine(core, r => replies.push(r), run => work.push(run));
	engine.handle({ type: "packet", data: packet(1, 2, 3), sequence: 1, generation: 7 });
	engine.handle({ type: "camera", x: 32, z: 48 });
	assert.equal(work.length, 1);
	work.shift()();
	assert.equal(replies[0].pending, 1);
	assert.equal(work.length, 1);
	engine.handle({ type: "predict", x: 1, y: 2, z: 3, block: 10, sequence: 2 });
	engine.handle({ type: "reset", sequence: 3 });
	work.shift()();
	assert.equal(work.length, 0);
	assert.deepEqual(calls, [["packet",1], ["generation",2,3,7], ["step",32,48], ["predict",1,2,3,10], ["reset"], ["step",32,48]]);
	assert.equal(replies.at(-1).sequence, 3);
	assert.equal(replies.at(-1).pending, 0);
});

test("two WASM worlds converge through transferred lighting, edits and fallback", t => {
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const main = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const workerCore = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	workerCore.exportLight();
	const worker = new Worker(), work = [];
	const engine = new LightEngine(workerCore, reply => {
		worker.reply(structuredClone(reply, { transfer: [reply.updates.buffer] }));
	}, run => work.push(run));
	worker.postMessage = (message, transfer) => engine.handle(structuredClone(message, { transfer }));
	const pool = new LightPool(main, () => worker);
	t.after(() => worker.onerror({}));
	worker.ready();
	const server = ServerCore.fromModule(new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url))));
	server.start(2026n, Generator.DebugHills); server.connect(1); server.packet(1, main.encodeHello(2));
	for (let i=0; i<30; i++) { server.tick(); for (const p of server.takeOutbox()) main.packet(p.data); }
	assert.ok(pool.queue > 0);
	assert.ok(main.lightPending > 0);
	assert.equal(main.stepLight(0,0) >= 0, true); // external instance does no calculation
	assert.ok(main.lightPending > 0);
	let slices = 0;
	while (work.length) { work.shift()(); assert.ok(++slices < 1000); }
	assert.equal(pool.queue, 0);
	assert.equal(main.lightPending, 0);
	assert.deepEqual(main.paddedLight(0,4,0), workerCore.paddedLight(0,4,0));
	main.predictBlock(15,80,8,10);
	while (work.length) work.shift()();
	assert.equal(workerCore.getBlock(15,80,8), 10);
	assert.deepEqual(main.paddedLight(1,8,0), workerCore.paddedLight(1,8,0));
	// A server correction uses the same ordered stream as prediction.
	const correction = new Uint8Array(14), v = new DataView(correction.buffer);
	correction[0] = 3; v.setInt32(1,15,false); v.setInt32(5,80,false); v.setInt32(9,8,false); correction[13] = 0;
	main.packet(correction);
	while (work.length) work.shift()();
	assert.equal(workerCore.getBlock(15,80,8), 0);
	assert.deepEqual(main.paddedLight(1,8,0), workerCore.paddedLight(1,8,0));
	worker.onerror({});
	assert.ok(pool.queue > 0);
	while (main.lightPending) pool.step(0,0);
	assert.equal(pool.queue, 0);
	assert.deepEqual(main.paddedLight(0,4,0), workerCore.paddedLight(0,4,0));
});
