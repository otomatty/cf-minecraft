import assert from "node:assert/strict";
import { test } from "node:test";
import { aimedMob, mobVertices, interpolateEntity, itemVertices, limitRenderItems, MAX_RENDER_ITEMS, mobBeforeBlock, mobAssetsByKind, MOB_SKIN_SIZE, type RenderMob, type RenderItem, type RenderSprite } from "./entities.ts";
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

test("sheep targeting uses a 0.9 by 1.3 foot-centered hitbox", () => {
	const sheep = { id: 1, kind: 3, position: [0, 0, 2] } as const;
	const pig = { id: 2, kind: 1, position: [0, 0, 2] } as const;
	const dir = [0, 0, 1];
	assert.deepEqual(aimedMob([0, 1.2, 0], dir, [sheep], 5), { id: sheep.id, distance: 1.55 });
	assert.equal(aimedMob([0, 1.2, 0], dir, [pig], 5), null);
	assert.deepEqual(aimedMob([0.45, 0.5, 0], dir, [sheep], 5), { id: sheep.id, distance: 1.55 });
	assert.equal(aimedMob([0.451, 0.5, 0], dir, [sheep], 5), null);
	assert.equal(aimedMob([-0.451, 0.5, 0], dir, [sheep], 5), null);
	assert.deepEqual(aimedMob([0, 1.3, 0], dir, [sheep], 5), { id: sheep.id, distance: 1.55 });
	assert.equal(aimedMob([0, 1.301, 0], dir, [sheep], 5), null);
	assert.equal(aimedMob([0, -0.001, 0], dir, [sheep], 5), null);
	assert.equal(aimedMob([0, 0.5, 0], dir, [sheep], 1.54), null);
});

test("chicken targeting uses a 0.4 by 0.7 foot-centered hitbox", () => {
	const chicken = { id: 1, kind: 2, position: [0, 0, 2] } as const;
	const pig = { id: 2, kind: 1, position: [0, 0, 3] } as const;
	const dir = [0, 0, 1];
	assert.deepEqual(aimedMob([0.2, 0.7, 0], dir, [chicken], 5), { id: chicken.id, distance: 1.8 });
	assert.equal(mobBeforeBlock([0.201, 0.7, 0], dir, [chicken, pig], 5, null), pig.id);
	assert.equal(aimedMob([0, 0.701, 0], dir, [chicken], 5), null);
	assert.equal(aimedMob([0, -0.001, 0], dir, [chicken], 5), null);
	assert.equal(aimedMob([0, 0.5, 0], dir, [chicken], 1.79), null);
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

const boxFloats = 36 * 9;
const quarterStride = Math.PI * 50;
const renderedHeights = [1.3, 0.9, 0.7, 1.2, 1.95, 1.99, 1.625] as const;

function component(vertices: Float32Array, index: number) {
	return vertices.filter((_, i) => i % 9 === index);
}

test("mobs stand on the ground at gameplay height and use their protocol skin layer", () => {
	assert.deepEqual(mobAssetsByKind.map(asset => asset.id), ["minecraft:cow", "minecraft:pig", "minecraft:chicken", "minecraft:sheep", "minecraft:zombie", "minecraft:skeleton", "minecraft:creeper"]);
	for (const kind of [0, 1, 2, 3, 4, 5, 6] as const) {
		const mob: RenderMob = { kind, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, light: [15, 3] };
		const asset = mobAssetsByKind[kind];
		const still = mobVertices([mob], [0, 0, 0], 0);
		const hurt = mobVertices([{ ...mob, hurt: true }], [0, 0, 0], 0);
		const cubes = asset.bones.flatMap(bone => bone.cubes ?? []);
		assert.equal(still.length, cubes.length * boxFloats);
		assert.equal(Math.min(...component(still, 1)), 0);
		assert.equal(Math.max(...component(still, 1)), Math.fround(renderedHeights[kind]));
		for (let i = 0; i < still.length; i += 9) {
			assert.equal(still[i + 6], kind);
			assert.equal(still[i + 7], 3.5 / 16);
			assert.equal(still[i + 8], 15.5 / 16);
			assert.equal(still[i + 5], -hurt[i + 5]);
			assert.ok(still[i + 3] >= 0 && still[i + 3] <= asset.texture.width / MOB_SKIN_SIZE);
			assert.ok(still[i + 4] >= 0 && still[i + 4] <= asset.texture.height / MOB_SKIN_SIZE);
		}
	}
});

test("aiming across the top of a rendered mob's head selects it from the front and the side", () => {
	for (const [kind, headBox] of [[0, 0], [1, 0], [2, 1], [4, 1], [5, 1]] as const) {
		for (const yaw of [0, 45, 90]) {
			const mob: RenderMob & { id: number } = { id: 12, kind, position: [0, 0, 0], yaw, moving: false, hurt: false, light: [15, 0] };
			const vertices = mobVertices([mob], [0, 0, 0], 0);
			const head = vertices.subarray(headBox * boxFloats, (headBox + 1) * boxFloats);
			const x = component(head, 0), y = component(head, 1), z = component(head, 2);
			const centerX = (Math.min(...x) + Math.max(...x)) / 2;
			const centerZ = (Math.min(...z) + Math.max(...z)) / 2;
			const brow = Math.max(...y) - 0.01;
			assert.equal(aimedMob([centerX, brow, 3], [0, 0, -1], [mob], 5)?.id, mob.id);
			assert.equal(aimedMob([3, brow, centerZ], [-1, 0, 0], [mob], 5)?.id, mob.id);
		}
	}
});

test("pig faces south at yaw zero: snout points outwards and box UVs stay upright", () => {
	const pig: RenderMob = { kind: 1, position: [29999998.25, 1, -29999998], yaw: 0, moving: false, hurt: false, light: [15, 3] };
	const camera = [29999998, 1, -29999998];
	const still = mobVertices([pig], camera, 0);
	const turned = mobVertices([{ ...pig, yaw: 90 }], camera, 0);
	for (let i = 0; i < still.length; i += 9) {
		assert.ok(Math.abs(turned[i] - (0.25 - still[i + 2])) < 1e-6);
		assert.ok(Math.abs(turned[i + 2] - (still[i] - 0.25)) < 1e-6);
	}
	const faceFloats = 6 * 9;
	const snoutFront = still.subarray(boxFloats + faceFloats, boxFloats + 2 * faceFloats);
	const scale = 0.9 / 16;
	assert.deepEqual([...new Set(component(snoutFront, 2))], [Math.fround(12 * scale)]);
	// In the catalog, the snout's front stretches from u=33..37 and v=1..4.
	for (let i = 0; i < snoutFront.length; i += 9) {
		assert.equal(snoutFront[i + 3] * MOB_SKIN_SIZE, snoutFront[i] < 0.25 ? 33 : 37);
		assert.equal(snoutFront[i + 4] * MOB_SKIN_SIZE, snoutFront[i + 1] === Math.fround(12 * scale) ? 1 : 4);
	}

	// A reflected model has to reverse triangle winding to survive back-face culling.
	const centre = [0.25, 12 * scale, 7 * scale];
	for (let i = 0; i < boxFloats; i += faceFloats) {
		const [ax, ay, az] = still.subarray(i, i + 3);
		const [bx, by, bz] = still.subarray(i + 9, i + 12);
		const [cx, cy, cz] = still.subarray(i + 18, i + 21);
		const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
		const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
		const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		assert.ok(nx * (ax - centre[0]) + ny * (ay - centre[1]) + nz * (az - centre[2]) > 0);
	}
	// Opposite legs mirror their side rectangles as well as the horizontal UV.
	assert.equal(still[3 * boxFloats + 3] * MOB_SKIN_SIZE, 44);
	assert.equal(still[4 * boxFloats + 3] * MOB_SKIN_SIZE, 56);
});

test("walking swings the catalog leg bones around their pivots while the body and wings keep their pose", () => {
	for (const kind of [0, 1, 2, 3] as const) {
		const mob: RenderMob = { kind, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, light: [15, 3] };
		const still = mobVertices([mob], [0, 0, 0], quarterStride);
		const moving = mobVertices([{ ...mob, moving: true }], [0, 0, 0], quarterStride);
		assert.deepEqual(mobVertices([{ ...mob, moving: true }], [0, 0, 0], 0), still);
		const asset = mobAssetsByKind[kind];
		const modelHeight = Math.max(...asset.bones.flatMap(b => (b.cubes ?? []).map(c => c.origin[1] + c.size[1])));
		const scale = renderedHeights[kind] / modelHeight;
		let offset = 0;
		for (const bone of asset.bones) {
			const end = offset + (bone.cubes?.length ?? 0) * boxFloats;
			const atRest = still.subarray(offset, end), posed = moving.subarray(offset, end);
			const pitch = asset.walkPitch[bone.name];
			if (pitch) {
				const first = bone.cubes![0];
				const centreY = first.origin[1] + first.size[1] / 2;
				const centreZ = first.origin[2] + first.size[2] / 2;
				const angle = -pitch * Math.PI / 180;
				const expectedDelta = -((centreY - bone.pivot[1]) * Math.sin(angle)
					+ (centreZ - bone.pivot[2]) * (Math.cos(angle) - 1)) * scale;
				const restZ = component(atRest.subarray(0, boxFloats), 2);
				const z = component(posed.subarray(0, boxFloats), 2);
				const delta = (Math.max(...z) + Math.min(...z) - Math.max(...restZ) - Math.min(...restZ)) / 2;
				assert.ok(Math.abs(delta - expectedDelta) < 1e-6);
			} else {
				assert.deepEqual(posed, atRest);
			}
			offset = end;
		}
	}
});

test("sheep mesh keeps two fleece boxes, a forward face and four hooves at the world border", () => {
	const sheep: RenderMob = { kind: 3, position: [29999998.25, 1, -29999998.5], yaw: 0, moving: false, hurt: false, light: [15, 3] };
	const still = mobVertices([sheep], sheep.position, 0);
	assert.equal(still.length, 7 * boxFloats);
	for (const [axis, min, max] of [[0, -0.42, 0.42], [1, 0, 1.2], [2, -0.4, 0.45]]) {
		const coordinates = still.filter((_, i) => i % 9 === axis);
		assert.equal(Math.min(...coordinates), Math.fround(min));
		assert.equal(Math.max(...coordinates), Math.fround(max));
	}
	const frontFace = (box: number) => still.subarray(box * boxFloats + 6 * 9, box * boxFloats + 12 * 9);
	for (const [box, left, top, width, height] of [
		[0, 16, 16, 16, 16], [1, 16, 16, 16, 16], [2, 8, 40, 16, 16], [3, 52, 36, 4, 16],
	]) {
		const face = frontFace(box);
		const u = component(face, 3), v = component(face, 4);
		assert.equal(Math.min(...u) * MOB_SKIN_SIZE, left);
		assert.equal(Math.max(...u) * MOB_SKIN_SIZE, left + width);
		assert.equal(Math.min(...v) * MOB_SKIN_SIZE, top);
		assert.equal(Math.max(...v) * MOB_SKIN_SIZE, top + height);
	}
	assert.ok(component(frontFace(2), 2).every(z => z === Math.fround(0.45)));
	const moving = mobVertices([{ ...sheep, moving: true }], sheep.position, quarterStride);
	for (const [leg, direction] of [[3, -1], [4, 1], [5, 1], [6, -1]]) {
		const foot = leg * boxFloats + 9; // second vertex is at floor height
		assert.equal(Math.sign(moving[foot + 2] - still[foot + 2]), direction);
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
	assert.deepEqual(core.mobs, [{ id, kind: 0, position, previous: position, yaw: 0, hurt: 0, fuse: 0 }]);
	const entityPacket = new Uint8Array(5);
	new DataView(entityPacket.buffer).setUint32(1, id);
	entityPacket[0] = S2C.MobHurt;
	assert.equal(core.packet(entityPacket), S2C.MobHurt);
	assert.equal(core.packet(packet(S2C.MobMove, moved, 270)), S2C.MobMove);
	assert.deepEqual(core.mobs, [{ id, kind: 0, position: moved, previous: position, yaw: 270, hurt: 1, fuse: 0 }]);
	assert.deepEqual([...core.encodeAttack(id)], [0x10, 0x80, 0, 0, 2]);
	entityPacket[0] = S2C.EntityRemove;
	core.packet(entityPacket);
	assert.deepEqual(core.mobs, []);
	assert.equal(core.packet(packet(S2C.MobSpawn, position, 90, 1)), S2C.MobSpawn);
	assert.deepEqual(core.mobs, [{ id, kind: 1, position, previous: position, yaw: 90, hurt: 0, fuse: 0 }]);
	core.resetWorld();
	assert.deepEqual(core.mobs, []);

	assert.equal(core.packet(packet(S2C.MobSpawn, position, 90, 6)), S2C.MobSpawn);
	const fusePacket = Uint8Array.of(S2C.MobFuse, ...entityPacket.subarray(1), 12);
	assert.equal(core.packet(fusePacket), S2C.MobFuse);
	assert.deepEqual(core.mobs, [{ id, kind: 6, position, previous: position, yaw: 90, hurt: 0, fuse: 12 }]);
	fusePacket[5] = 0;
	assert.equal(core.packet(fusePacket), S2C.MobFuse);
	assert.equal(core.mobs[0].fuse, 0);
});

test("zombie head uses the front of the 64×32 skin and the legs swing in opposite directions", () => {
	const mob: RenderMob = { kind: 4, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, light: [10, 0] };
	const asset = mobAssetsByKind[4];
	assert.deepEqual([asset.texture.width, asset.texture.height], [64, 32]);
	const still = mobVertices([mob], [0, 0, 0], 0);
	const stride = mobVertices([{ ...mob, moving: true }], [0, 0, 0], quarterStride);
	const legStart = 4 * boxFloats;
	assert.deepEqual(stride.subarray(0, legStart), still.subarray(0, legStart));
	for (const [start, sign] of [[legStart, -1], [legStart + boxFloats, 1]] as const) {
		const lowerFrontVertex = start + 6 * 9 + 9;
		assert.equal(still[lowerFrontVertex + 1], 0);
		assert.ok((stride[lowerFrontVertex + 2] - still[lowerFrontVertex + 2]) * sign > 0);
	}
	const front = still.subarray(boxFloats + 6 * 9, boxFloats + 12 * 9);
	assert.equal(new Set(component(front, 2)).size, 1);
	for (let i = 0; i < front.length; i += 9) {
		assert.equal(front[i + 3] * MOB_SKIN_SIZE, front[i] < 0 ? 8 : 16);
		assert.equal(front[i + 4] * MOB_SKIN_SIZE, front[i + 1] === Math.fround(1.95) ? 8 : 16);
	}
});

test("creeper uses the 64×32 skin, swells with its fuse, and flashes white on odd fuse quarters", () => {
	const creeper: RenderMob & { id: number } = {
		id: 9, kind: 6, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, fuse: 0, light: [15, 3],
	};
	const asset = mobAssetsByKind[6];
	assert.deepEqual([asset.texture.width, asset.texture.height], [64, 32]);
	assert.equal(aimedMob([0, 1.69, 3], [0, 0, -1], [creeper], 5)?.id, 9);
	assert.equal(aimedMob([0, 1.71, 3], [0, 0, -1], [creeper], 5), null);
	const still = mobVertices([creeper], [0, 0, 0], 0);
	const swollen = mobVertices([{ ...creeper, fuse: 30 }], [0, 0, 0], 0);
	assert.equal(Math.max(...component(still, 1)), Math.fround(1.625));
	assert.equal(Math.max(...component(swollen, 1)), Math.fround(1.625 * 1.2));
	const flashing = mobVertices([{ ...creeper, fuse: 4 }], [0, 0, 0], 0);
	const quiet = mobVertices([{ ...creeper, fuse: 3 }], [0, 0, 0], 0);
	for (let i = 5; i < still.length; i += 9) {
		assert.equal(flashing[i], Math.fround(still[i] + 2));
		assert.equal(quiet[i], still[i]);
	}
	const stride = mobVertices([{ ...creeper, moving: true }], [0, 0, 0], quarterStride);
	const legStart = 2 * boxFloats;
	assert.deepEqual(stride.subarray(0, legStart), still.subarray(0, legStart));
	assert.notDeepEqual(stride.subarray(legStart), still.subarray(legStart));
	const front = still.subarray(boxFloats + 6 * 9, boxFloats + 12 * 9);
	assert.equal(new Set(component(front, 2)).size, 1);
	for (let i = 0; i < front.length; i += 9) {
		assert.equal(front[i + 3] * MOB_SKIN_SIZE, front[i] < 0 ? 8 : 16);
		assert.equal(front[i + 4] * MOB_SKIN_SIZE, front[i + 1] === Math.fround(1.625) ? 8 : 16);
	}
});

test("skeleton uses the 64×32 skin, taller hitbox, and a bow parented to its moving arm", () => {
	const skeleton: RenderMob & { id: number } = {
		id: 7, kind: 5, position: [0, 0, 0], yaw: 0, moving: false, hurt: false, light: [15, 3],
	};
	const asset = mobAssetsByKind[5];
	assert.deepEqual([asset.texture.width, asset.texture.height], [64, 32]);
	assert.equal(aimedMob([0, 1.98, 3], [0, 0, -1], [skeleton], 5)?.id, 7);
	assert.equal(aimedMob([0, 2, 3], [0, 0, -1], [skeleton], 5), null);
	const output: RenderSprite[] = [];
	const textures = new Map([["bow", 123]]);
	mobVertices([skeleton], [0, 0, 0], 0, { output, textures });
	mobVertices([{ ...skeleton, moving: true }], [0, 0, 0], quarterStride, { output, textures });
	assert.equal(output.length, 2);
	assert.ok(output.every(sprite => sprite.texture === 123));
	assert.notDeepEqual(output[0].corners, output[1].corners);
	const vertices = itemVertices([], [0, 0, 0], 0, output);
	assert.equal(vertices.length, 2 * 12 * 9);
	assert.ok(component(vertices, 6).every(layer => layer === 123));
});

test("arrow sprite aligns its diagonal with velocity and stays camera relative", () => {
	const item: RenderItem = { position: [29999998.25, 1, -29999998], velocity: [0, -1, 0], texture: 7, light: [15, 3] };
	const vertices = itemVertices([item], [29999998, 1, -29999998], 0);
	assert.equal(vertices.length, 12 * 9);
	const tail = vertices.subarray(0, 3), tip = vertices.subarray(18, 21);
	assert.equal(tail[0], 0.25);
	assert.equal(tip[0], 0.25);
	assert.equal(tail[2], tip[2]);
	assert.ok(tip[1] < tail[1]);
	assert.ok(component(vertices, 6).every(layer => layer === 7));
});

test("WASM arrow records carry freshness and velocity and interpolate from the last received position", async () => {
	const { readFileSync } = await import("node:fs");
	const { ClientCore, S2C } = await import("./client-core.ts");
	const { instance } = await WebAssembly.instantiate(readFileSync(new URL("../wasm/client.wasm", import.meta.url)), {});
	const core = new ClientCore(instance);
	const id = 0xffff_ffff;
	const arrow = (tag: number, position: number[], velocity: number[], fresh = false) => {
		const spawn = tag === S2C.ArrowSpawn;
		const bytes = new Uint8Array(spawn ? 54 : 53), view = new DataView(bytes.buffer);
		bytes[0] = tag;
		view.setUint32(1, id);
		[...position, ...velocity].forEach((value, i) => view.setFloat64(5 + i * 8, value));
		if (spawn) bytes[53] = Number(fresh);
		return bytes;
	};
	const position = [29999998.25, 1, -3.5], next = [29999998.5, 1, -3.5];
	const velocity = [0.25, 0, 0], nextVelocity = [0.2475, -0.05, 0];
	assert.equal(core.packet(arrow(S2C.ArrowSpawn, position, velocity, true)), S2C.ArrowSpawn);
	assert.deepEqual(core.arrows, [{ id, position, previous: position, velocity, fresh: true }]);
	assert.equal(core.packet(arrow(S2C.ArrowMove, next, nextVelocity)), S2C.ArrowMove);
	assert.deepEqual(core.arrows, [{ id, position: next, previous: position, velocity: nextVelocity, fresh: false }]);
	const remove = new Uint8Array([S2C.EntityRemove, 255, 255, 255, 255]);
	assert.equal(core.packet(remove), S2C.EntityRemove);
	assert.deepEqual(core.arrows, []);
	assert.equal(core.packet(arrow(S2C.ArrowSpawn, position, velocity)), S2C.ArrowSpawn);
	assert.deepEqual(core.arrows, [{ id, position, previous: position, velocity, fresh: false }]);
	core.resetWorld();
	assert.deepEqual(core.arrows, []);
});
