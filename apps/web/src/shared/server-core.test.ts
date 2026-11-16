import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClientCore } from "../client/client-core.ts";
import { ChunkGenCore, Generator, ServerCore } from "./server-core.ts";

const module = new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url)));
const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));

test("external generation delivers the same chunks through Node WASM wrappers", () => {
	const gen = ChunkGenCore.fromModule(module);
	for (const generator of [Generator.Terrain, Generator.Flat, Generator.DebugHills]) {
		const server = ServerCore.fromModule(module);
		const local = ServerCore.fromModule(module);
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		server.start(2026n, generator);
		local.start(2026n, generator);
		server.setExternalGeneration(3);
		for (const core of [server, local]) {
			core.connect(1);
			core.packet(1, client.encodeHello(2));
		}
		server.tick();
		local.tick();
		for (const { data } of server.takeOutbox()) client.packet(data);
		assert.equal(client.chunkCount, 0);
		const requests = server.takeGenerationRequests();
		assert.equal(requests.length, 3);
		server.tick();
		assert.deepEqual(server.takeGenerationRequests(), []);
		const generated = requests.map(([cx, cz]) => gen.generate(2026n, generator, cx, cz));
		// Later calls and seed switches must not invalidate earlier returned bytes.
		gen.generate(-71n, Generator.Terrain, -2, 3);
		for (let i = 0; i < requests.length; i++) {
			const [cx, cz] = requests[i];
			assert.equal(server.deliverGenerated(cx, cz, generated[i]), true);
		}
		server.tick();
		const delivered = server.takeOutbox().filter(({ data }) => data[0] === 0x01);
		const expected = local.takeOutbox().filter(({ data }) => data[0] === 0x01);
		assert.equal(delivered.length, 3);
		assert.deepEqual(delivered, expected.slice(0, 3));
		for (const { data } of delivered) client.packet(data);
		assert.equal(client.chunkCount, 3);
		assert.equal(server.dirtyChunks, 0);
		assert.equal(server.takeDirty(), null);
		const fallback = server.takeGenerationRequests();
		assert.equal(fallback.length, 3);
		server.generateNow(...fallback[0]);
		assert.equal(server.deliverGenerated(...fallback[0], new Uint8Array()), false);
		assert.equal(server.deliverGenerated(...fallback[1], new Uint8Array([1, 2, 3])), false);
		assert.equal(server.loadedChunks, 5);
	}
});
