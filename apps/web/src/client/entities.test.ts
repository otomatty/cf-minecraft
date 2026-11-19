import assert from "node:assert/strict";
import { test } from "node:test";
import { aimedMob, mobVertices, interpolateEntity, itemVertices, limitRenderItems, MAX_RENDER_ITEMS, mobBeforeBlock, type MobTextures, type RenderMob, type RenderItem } from "./entities.ts";
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

const textures: MobTextures = {
	cow_hide: 5, cow_face: 6, cow_leg: 7, pig_skin: 8, pig_face: 9, pig_leg: 10, pig_snout: 11,
};

test("cow targeting uses the nearest forward hitbox within reach", () => {
	const origin = [0, 1.62, 0];
	const dir = [0, 0, 1];
	const near = { id: 1, kind: 0, position: [0, 0.5, 2] } as const;
	const far = { id: 2, kind: 0, position: [0, 0.5, 4] } as const;
	assert.deepEqual(aimedMob(origin, dir, [near], 5), { id: 1, distance: 1.55 });
	assert.equal(aimedMob(origin, dir, [far, near], 5)?.id, near.id);
	assert.equal(aimedMob(origin, dir, [
		{ id: 3, kind: 0, position: [0, 0.5, -2] },
		{ id: 4, kind: 0, position: [0, 0.5, 5.5] },
		{ id: 5, kind: 0, position: [0.5, 0.5, 2] },
		{ id: 6, kind: 0, position: [0, 0, 2] },
	], 5), null);
});

test("cow targeting gives the block priority at or before its hitbox", () => {
	const cow = { id: 1, kind: 0, position: [0.5, 0, 3.5] } as const;
	const origin = [0.5, 1, 6], dir = [0, 0, -1];
	const block = { x: 0, y: 0, z: 4, face: 3, hitY: 1, min: [0, 0, 0], max: [1, 1, 1] } as const;
	assert.equal(mobBeforeBlock(origin, dir, [cow], 5, block), null);
	assert.equal(mobBeforeBlock(origin, dir, [cow], 5, { ...block, z: 2 }), cow.id);
	const tiedCow = { id: 2, kind: 0, position: [0.5, 0, 1.55] } as const;
	assert.equal(mobBeforeBlock(origin, dir, [tiedCow], 5, { ...block, z: 1 }), null);
});
test("a ray above the pig's hitbox can still hit a cow", () => {
	const pig = { id: 1, kind: 1, position: [0, 0, 2] } as const;
	const cow = { id: 2, kind: 0, position: [0, 0, 3] } as const;
	const dir = [0, 0, 1];
	assert.equal(mobBeforeBlock([0.44, 1, 0], dir, [pig, cow], 5, null), cow.id);
	assert.deepEqual(aimedMob([0.44, 0.9, 0], dir, [pig, cow], 5), { id: pig.id, distance: 1.55 });
	assert.equal(aimedMob([0.46, 0.9, 0], dir, [pig, cow], 5), null);
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


test("non-block drops are rotating double-sided planes with full sprite UVs", () => {
	const item: RenderItem = { position: [3, 4, 5], texture: 28, light: [15, 0], flat: true };
	const vertices = itemVertices([item], [0, 0, 0], 0);
	assert.equal(vertices.length, 12 * 9);
	for (let i = 0; i < vertices.length; i += 9) {
		assert.equal(vertices[i + 2], 5);
		assert.equal(vertices[i + 6], 28);
	}
	for (let side = 0; side < 2; side++) {
		const start = side * 6 * 9;
		assert.deepEqual(new Set(Array.from({ length: 6 }, (_, i) => `${vertices[start + i * 9 + 3]}:${vertices[start + i * 9 + 4]}`)), new Set(["0:0", "0:1", "1:0", "1:1"]));
		const a = start, b = start + 9, c = start + 18;
		const normalZ = (vertices[b] - vertices[a]) * (vertices[c+1] - vertices[a+1]) - (vertices[b+1] - vertices[a+1]) * (vertices[c] - vertices[a]);
		assert.ok(side === 0 ? normalZ > 0 : normalZ < 0);
	}
	const rotated = itemVertices([item], [0, 0, 0], Math.PI * 1000);
	assert.notEqual(rotated[2], vertices[2]);
});

test("cow mesh has six boxes, turns with yaw, and swings diagonal legs together", () => {
	const cow: RenderMob = { kind: 0, position: [29999998.25, 1, 0], yaw: 0, moving: false, hurt: false, light: [15, 3] };
	const camera = [29999998, 1, 0];
	const quarterStride = Math.PI * 50;
	const still = mobVertices([cow], camera, quarterStride, textures);
	const turned = mobVertices([{ ...cow, yaw: 90 }], camera, quarterStride, textures);
	const moving = mobVertices([{ ...cow, moving: true }], camera, quarterStride, textures);
	assert.equal(still.length, 6 * 36 * 9);
	for (let i = 0; i < still.length; i += 9) {
		assert.ok(Math.abs(turned[i] - (0.25 - still[i + 2])) < 1e-6);
		assert.ok(Math.abs(turned[i + 2] - (still[i] - 0.25)) < 1e-6);
		assert.equal(still[i + 7], 3.5 / 16);
		assert.equal(still[i + 8], 15.5 / 16);
	}
	const box = 36 * 9;
	assert.equal(still[box + 3 * 6 * 9 + 6], textures.cow_face);
	assert.deepEqual(moving.slice(0, 2 * box), still.slice(0, 2 * box));
	for (const [leg, sign] of [-1, 1, 1, -1].entries()) {
		const z = (leg + 2) * box + 2;
		assert.equal(Math.sign(moving[z] - still[z]), sign);
	}
	assert.deepEqual(mobVertices([{ ...cow, moving: true }], camera, 0, textures), still);
});

test("pig mesh has seven boxes, a separate snout, and shared leg motion and hurt shading", () => {
	const pig: RenderMob = { kind: 1, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, light: [15, 3] };
	const camera = [0, 0, 0];
	const quarterStride = Math.PI * 50;
	const still = mobVertices([pig], camera, quarterStride, textures);
	const moving = mobVertices([{ ...pig, moving: true, hurt: true }], camera, quarterStride, textures);
	const box = 36 * 9;
	assert.equal(still.length, 7 * box);
	const expectedMin = [-0.42, 0, -0.46], expectedMax = [0.42, 0.9, 0.60];
	for (let axis = 0; axis < 3; axis++) {
		const coordinates = still.filter((_, i) => i % 9 === axis);
		assert.equal(Math.min(...coordinates), Math.fround(expectedMin[axis]));
		assert.equal(Math.max(...coordinates), Math.fround(expectedMax[axis]));
	}
	assert.equal(still[box + 3 * 6 * 9 + 6], textures.pig_face);
	assert.equal(still[2 * box + 3 * 6 * 9 + 6], textures.pig_snout);
	for (let i = 5; i < moving.length; i += 9) assert.equal(moving[i], -still[i]);
	for (const [leg, sign] of [-1, 1, 1, -1].entries()) {
		const z = (leg + 3) * box + 2;
		assert.equal(Math.sign(moving[z] - still[z]), sign);
	}
});

test("WASM mob records track hurt, yaw and previous position and clear on removal and reset", async () => {
	const { readFileSync } = await import("node:fs");
	const { ClientCore, S2C } = await import("./client-core.ts");
	const { instance } = await WebAssembly.instantiate(readFileSync(new URL("../wasm/client.wasm", import.meta.url)), {});
	const core = new ClientCore(instance);
	const id = 0x80000002;
	const packet = (tag: number, position: number[], yaw: number, kind?: number) => {
		const offset = kind === undefined ? 5 : 6;
		const bytes = new Uint8Array(offset + 28), view = new DataView(bytes.buffer);
		bytes[0] = tag;
		view.setUint32(1, id);
		if (kind !== undefined) view.setUint8(5, kind);
		position.forEach((v, axis) => view.setFloat64(offset + axis * 8, v));
		view.setFloat32(offset + 24, yaw);
		return bytes;
	};
	const position = [29999998.25, 1, -3.5], moved = [29999998.5, 1, -3.5];
	const spawn = packet(S2C.MobSpawn, position, 0, 0);
	assert.equal(core.packet(spawn), S2C.MobSpawn);
	assert.deepEqual(core.mobs, [{ id, kind: 0, position, previous: position, yaw: 0, hurt: 0 }]);
	const entityPacket = new Uint8Array(5);
	new DataView(entityPacket.buffer).setUint32(1, id);
	entityPacket[0] = S2C.MobHurt;
	assert.equal(core.packet(entityPacket), S2C.MobHurt);
	assert.equal(core.packet(packet(S2C.MobMove, moved, 270)), S2C.MobMove);
	assert.deepEqual(core.mobs, [{ id, kind: 0, position: moved, previous: position, yaw: 270, hurt: 1 }]);
	assert.deepEqual([...core.encodeAttack(id)], [0x10, 0x80, 0, 0, 2]);
	entityPacket[0] = S2C.EntityRemove;
	core.packet(entityPacket);
	assert.deepEqual(core.mobs, []);
	assert.equal(core.packet(packet(S2C.MobSpawn, position, 90, 1)), S2C.MobSpawn);
	assert.deepEqual(core.mobs, [{ id, kind: 1, position, previous: position, yaw: 90, hurt: 0 }]);
	core.resetWorld();
	assert.deepEqual(core.mobs, []);
});
