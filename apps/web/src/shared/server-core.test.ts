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

test("inventory and game mode cross the server/client ABI and survive reconnect", () => {
	const server = ServerCore.fromModule(module);
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const join = (inventory?: Uint8Array) => {
		server.connect(1, false, undefined, inventory);
		server.packet(1, client.encodeHello(2)); server.tick();
		const packets = server.takeOutbox();
		assert.equal(packets[0].data[0], 0);
		assert.equal(packets[1].data[0], 6);
		for (const { data } of packets) assert.notEqual(client.packet(data), -1);
	};
	server.start(2026n, Generator.Flat);
	server.setGameMode("survival"); join();
	assert.equal(client.gameMode, "survival");
	assert.deepEqual(client.inventory, Array(36).fill(null));
	server.packet(1, client.encodeCreativeSetSlot(0, 1, 64)); server.tick();
	for (const { data } of server.takeOutbox()) client.packet(data);
	assert.equal(client.inventory[0], null);
	server.disconnect(1);
	server.setGameMode("creative"); join(new Uint8Array([0]));
	const items = client.itemRegistry();
	assert.equal(items.find(i => i.id === client.inventory[0]!.item)?.name, "stone");
	const slab = items.find(i => i.name === "oak_slab")!;
	assert.equal(slab.maxStack, 64);
	assert.equal(client.blockRegistry()[slab.block!].name, "oak_slab");
	server.packet(1, client.encodeSelectSlot(8));
	server.packet(1, client.encodeCreativeSetSlot(35, slab.id, 17)); server.tick();
	assert.equal(server.takeOutbox().filter(p => p.data[0] === 6).length, 1);
	const saved = server.inventoryData(1)!;
	assert.equal(saved[0], 3);
	assert.equal(saved.length, 152);
	server.disconnect(1);
	assert.equal(server.inventoryData(1), undefined);
	join(saved);
	assert.equal(client.selectedSlot, 8);
	assert.deepEqual(client.inventory[35], { item: slab.id, count: 17 });
	assert.deepEqual(server.inventoryData(1), saved);
});

test("returnCrafting clears transient stacks before taking a multiplayer snapshot", () => {
	const server = ServerCore.fromModule(module);
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	server.start(2026n, Generator.Flat);
	server.connect(1);
	server.packet(1, client.encodeHello(2)); server.tick(); server.takeOutbox();
	for (const slot of [4, 36, 2]) server.packet(1, client.encodeClickSlot(slot, 0, false));
	server.tick(); server.takeOutbox();
	const before = server.inventoryData(1)!;
	assert.equal(new DataView(before.buffer, before.byteOffset).getUint16(110), 8);
	assert.equal(new DataView(before.buffer, before.byteOffset).getUint16(122), 5);
	server.returnCrafting(1);
	const saved = server.inventoryData(1)!;
	assert.equal(saved[0], 3);
	assert.ok(saved.slice(110).every(byte => byte === 0));
	server.disconnect(1);
	server.connect(1, false, undefined, saved);
	assert.deepEqual(server.inventoryData(1), saved);
});

test("crafting table screen and grid cross the WASM ABI and return before multiplayer reconnect", () => {
	const server = ServerCore.fromModule(module);
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	server.start(2026n, Generator.Flat);
	server.connect(1);
	server.packet(1, client.encodeHello(2)); server.tick();
	const receive = () => { for (const { data } of server.takeOutbox()) assert.notEqual(client.packet(data), -1); };
	receive();
	const [px, py, pz] = client.spawn;
	const pos = [Math.floor(px) + 1, Math.floor(py), Math.floor(pz)] as const;
	const table = client.blockRegistry().find(b => b.name === "crafting_table")!;
	server.packet(1, client.encodeSetBlock(...pos, table.first));
	server.packet(1, client.encodeUseBlock(...pos)); server.tick(); receive();
	assert.equal(client.screen, 1);
	server.packet(1, client.encodeClickSlot(4, 0, false));
	server.packet(1, client.encodeClickSlot(49, 0, false)); server.tick(); receive();
	assert.deepEqual(client.table[8], { item: 8, count: 1 });
	assert.deepEqual(client.craftingResult, { item: 5, count: 4 });
	const before = server.inventoryData(1)!;
	assert.equal(before[0], 3);
	assert.equal(new DataView(before.buffer, before.byteOffset).getUint16(149), 8);
	server.returnCrafting(1);
	const saved = server.inventoryData(1)!;
	assert.ok(saved.slice(110).every(byte => byte === 0));
	server.disconnect(1);
	server.connect(1, false, undefined, saved);
	server.packet(1, client.encodeHello(2)); server.tick(); receive();
	assert.equal(client.screen, 0);
	assert.deepEqual(client.table, Array(9).fill(null));
	assert.equal(client.inventory.filter(s => s?.item === 8).reduce((n, s) => n + s!.count, 0), 1);
});
