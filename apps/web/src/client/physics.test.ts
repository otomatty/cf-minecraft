import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClientCore } from "./client-core.ts";
import { Generator, ServerCore } from "../shared/server-core.ts";

const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
const serverModule = new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url)));
function fixture(): ClientCore {
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const server = ServerCore.fromModule(serverModule);
	server.start(2026n, Generator.Flat);
	server.connect(1);
	server.packet(1, client.encodeHello(2));
	for (let i = 0; i < 20; i++) {
		server.tick();
		for (const packet of server.takeOutbox()) client.packet(packet.data);
	}
	// Use the same y=0 floor as the native fixture, inside loaded chunks.
	for (let x = -2; x <= 2; x++) {
		for (let z = -2; z <= 14; z++) assert.equal(client.predictBlock(x, -1, z, 1), true);
	}
	client.resetPlayer(0.5, 0, 0.5);
	return client;
}

test("WASM mirror and native physics match the fixed tick trajectory", () => {
	const client = fixture();
	assert.equal(client.toggleFlight(), false);
	client.tickPlayer(0, 0, 0, false, false, false);
	assert.equal(client.tickPlayer(0, 0, 0, false, false, false).onGround, true);
	const csv = readFileSync(new URL("../../../../crates/physics/tests/trajectory.csv", import.meta.url), "utf8");
	for (const line of csv.trim().split("\n").filter(line => !line.startsWith("#"))) {
		const [tick, flags, ...expected] = line.split(",").map(Number);
		const state = client.tickPlayer(1, 0, 0, !!(flags & 1), !!(flags & 2), false);
		for (const [axis, value] of [...state.position, ...state.velocity].entries()) {
			assert.ok(Math.abs(value - expected[axis]) < 1e-14, `tick ${tick}, component ${axis}: ${value} != ${expected[axis]}`);
		}
		assert.equal(state.onGround, !!expected[6], `tick ${tick}`);
		assert.equal(state.flying, false);
	}
});

test("flight starts stationary, collides with mirrored blocks, and refuses walking inside blocks", () => {
	const client = fixture();
	for (let i = 0; i < 10; i++) {
		const state = client.tickPlayer(0, 0, 0, false, false, false);
		assert.deepEqual(state.position, [0.5, 0, 0.5]);
		assert.equal(state.flying, true);
	}
	client.predictBlock(0, 0, 2, 1);
	client.predictBlock(0, 1, 2, 1);
	for (let i = 0; i < 40; i++) client.tickPlayer(1, 0, 0, false, false, false);
	const stopped = client.tickPlayer(1, 0, 0, false, false, false);
	assert.equal(stopped.position[2], 2 - Math.fround(0.6) / 2);
	assert.equal(stopped.velocity[2], 0);
	client.resetPlayer(0.5, 0, 2.5);
	assert.equal(client.toggleFlight(), true);
	// Escape an overlapping block in flight, then walking is safe again.
	for (let i = 0; i < 40; i++) client.tickPlayer(-1, 0, 0, false, false, false);
	assert.equal(client.toggleFlight(), false);
	// A reset (the debug setCamera path) discards old velocity and resumes flight.
	client.resetPlayer(0.5, 5, 0.5);
	assert.deepEqual(client.tickPlayer(0, 0, 0, false, false, false).position, [0.5, 5, 0.5]);
});

test("unloaded chunks block movement and prevent switching to walking", () => {
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	client.resetPlayer(0.5, 5, 0.5);
	assert.equal(client.toggleFlight(), true);
	const loaded = fixture();
	loaded.resetPlayer(47.5, 5, 0.5); // edge of the loaded view (chunk 2)
	for (let i = 0; i < 80; i++) loaded.tickPlayer(0, -1, 0, false, true, false);
	const state = loaded.tickPlayer(0, -1, 0, false, true, false);
	assert.equal(state.position[0], 48 - Math.fround(0.6) / 2);
	assert.equal(state.velocity[0], 0);
});

test("WASM and native flight share the same sine-table trajectory", () => {
	const client = fixture();
	client.resetPlayer(0.5, 5, 0.5);
	const csv = readFileSync(new URL("../../../../crates/physics/tests/flight.csv", import.meta.url), "utf8");
	for (const line of csv.trim().split("\n").filter(line => !line.startsWith("#"))) {
		const [tick, forward, strafe, yaw, flags, ...expected] = line.split(",").map(Number);
		const state = client.tickPlayer(forward, strafe, yaw, !!(flags & 1), !!(flags & 2), !!(flags & 4));
		for (const [axis, value] of [...state.position, ...state.velocity].entries()) {
			assert.ok(Math.abs(value - expected[axis]) < 1e-14, `tick ${tick}, component ${axis}: ${value} != ${expected[axis]}`);
		}
		assert.equal(state.onGround, false);
		assert.equal(state.flying, true);
	}
});
