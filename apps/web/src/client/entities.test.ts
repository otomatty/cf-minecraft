import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolateEntity, itemVertices, limitRenderItems, MAX_RENDER_ITEMS, type RenderItem } from "./entities.ts";
import { ACTIONS, defaultSettings, loadSettings, SETTINGS_KEY } from "./input-settings.ts";

test("drop defaults to Q and old preferences migrate without losing assigned Q", () => {
	assert.ok(ACTIONS.includes("drop")); assert.equal(defaultSettings().keys.drop,"KeyQ");
	const old = { ...defaultSettings(), keys: { ...defaultSettings().keys, forward:"KeyQ" } };
	const { drop: _drop, ...keys } = old.keys;
	let saved = JSON.stringify({ ...old, keys });
	const loaded = loadSettings({ getItem: key => key === SETTINGS_KEY ? saved : null, setItem: (_key,value) => { saved=value; },removeItem: () => {} });
	assert.equal(loaded.keys.forward,"KeyQ"); assert.notEqual(loaded.keys.drop,"KeyQ"); assert.deepEqual(JSON.parse(saved),loaded);
});
test("entity interpolation clamps tick boundaries and keeps border precision", () => {
	const a=[29999998,2,-29999998],b=[29999998.25,3,-29999998.5];
	assert.deepEqual(interpolateEntity(a,b,-5),a); assert.deepEqual(interpolateEntity(a,b,100),b);
	assert.deepEqual(interpolateEntity(a,b,25),[29999998.125,2.5,-29999998.25]);
});
test("cube vertices remain camera relative, bounded, and use lightmap coordinates", () => {
	const vertices=itemVertices([{position:[29999998,1,-29999998],texture:7,light:[15,3]}],[29999998,1,-29999998],0);
	assert.equal(vertices.length,36*9);
	for(let i=0;i<vertices.length;i+=9) {
		assert.ok(Math.abs(vertices[i])<=0.125); assert.ok(Math.abs(vertices[i+2])<=0.125);
		assert.equal(vertices[i+6],7); assert.equal(vertices[i+7],3.5/16); assert.equal(vertices[i+8],15.5/16);
	}
});

test("WASM entity records expose unsigned IDs, current/previous positions and count changes", async () => {
	const { readFileSync } = await import("node:fs");
	const { ClientCore, S2C } = await import("./client-core.ts");
	const { instance } = await WebAssembly.instantiate(readFileSync(new URL("../wasm/client.wasm", import.meta.url)), {});
	const core = new ClientCore(instance);
	const id = 0x80000001;
	const spawn = new Uint8Array(33), view = new DataView(spawn.buffer);
	spawn[0] = S2C.EntitySpawn;
	view.setUint32(1, id); spawn[5] = 0; view.setUint16(6, 1); spawn[8] = 3;
	view.setFloat64(9, 29999998.25); view.setFloat64(17, 2.5); view.setFloat64(25, -3.25);
	assert.equal(core.packet(spawn), S2C.EntitySpawn);
	assert.deepEqual(core.entities, [{ id, item: 1, count: 3, position: [29999998.25, 2.5, -3.25], previous: [29999998.25, 2.5, -3.25] }]);
	const move = new Uint8Array(29), moved = new DataView(move.buffer);
	move[0] = S2C.EntityMove; moved.setUint32(1, id);
	moved.setFloat64(5, 29999998.5); moved.setFloat64(13, 2); moved.setFloat64(21, -4);
	core.packet(move);
	const count = new Uint8Array(6); count[0] = S2C.EntityCount; new DataView(count.buffer).setUint32(1, id); count[5] = 2;
	core.packet(count);
	assert.deepEqual(core.entities[0], { id, item: 1, count: 2, position: [29999998.5, 2, -4], previous: [29999998.25, 2.5, -3.25] });
	const drop = core.encodeDropItem([0.25, -0.5, 1]);
	assert.equal(drop[0], 6); assert.equal(drop.length, 13); assert.equal(new DataView(drop.buffer).getFloat32(5), -0.5);
	const remove = new Uint8Array(5); remove[0] = S2C.EntityRemove; new DataView(remove.buffer).setUint32(1, id);
	core.packet(remove); assert.deepEqual(core.entities, []);
});


test("render items are capped before vertex generation and preserve input order", () => {
	const items: RenderItem[] = Array.from({ length: 1100 }, (_, i) => ({ position: [i, 1, 0], texture: 0, light: [15, 0] }));
	const limited = limitRenderItems(items);
	assert.equal(limited.length, MAX_RENDER_ITEMS);
	assert.equal(limited[0], items[0]);
	assert.equal(limited[MAX_RENDER_ITEMS - 1], items[MAX_RENDER_ITEMS - 1]);
	assert.equal(items.length, 1100);
	assert.equal(itemVertices(limited, [0, 0, 0], 0).byteLength, MAX_RENDER_ITEMS * 36 * 36);
	assert.deepEqual(limitRenderItems([]), []);
	assert.deepEqual(limitRenderItems(items.slice(0, 3)), items.slice(0, 3));
	assert.equal(limitRenderItems(items.slice(0, MAX_RENDER_ITEMS)).length, MAX_RENDER_ITEMS);
});
