import assert from "node:assert/strict";
import { test } from "node:test";
import { mobAssets } from "./catalog.ts";
import { decodedFixturePack } from "../../../test/texture-pack-fixture.mjs";

const fixture = await decodedFixturePack();
const packTile = (name: string): Uint8Array => {
	const tile = fixture.tiles.get(name);
	assert.ok(tile, name);
	return tile;
};

test("adult mob visuals can be looked up by Bedrock identifier", () => {
	for (const name of ["pig", "cow", "chicken", "sheep", "zombie", "skeleton", "creeper"]) {
		const id = `minecraft:${name}`;
		assert.equal(mobAssets.get(id)?.id, id);
	}
	assert.equal(mobAssets.get("minecraft:unknown"), undefined);
});

for (const [id, { bones, texture, walkPitch }] of mobAssets) {
	test(`${id} has the expected box UVs and a bone for every walk channel`, () => {
		const pixels = texture.pixels(), names = new Set<string>();
		assert.equal(pixels.length, texture.width * texture.height * 4);
		assert.deepEqual(pixels, texture.pixels());
		for (const bone of bones) {
			assert.ok(!names.has(bone.name), `duplicate ${bone.name}`);
			if (bone.parent) assert.ok(names.has(bone.parent), `missing parent for ${bone.name}`);
			names.add(bone.name);
			assert.ok([...bone.pivot, ...(bone.rotation ?? [])].every(Number.isFinite));
			for (const cube of bone.cubes ?? []) {
				assert.ok(cube.origin.every(Number.isFinite));
				assert.ok(cube.size.every(n => Number.isFinite(n) && n > 0));
				const [w, h, d] = cube.uvSize ?? cube.size, [u, v] = cube.uv;
				assert.ok([w, h, d].every(n => Number.isInteger(n) && n > 0));
				assert.ok(cube.uv.every(n => Number.isInteger(n) && n >= 0));
				assert.ok(u + 2 * (w + d) <= texture.width && v + d + h <= texture.height);
				for (const [x, y, width, height] of [
					[u + d, v, w, d], [u + d + w, v, w, d],
					[u, v + d, d, h], [u + d, v + d, w, h],
					[u + d + w, v + d, d, h], [u + 2 * d + w, v + d, w, h],
				]) {
					let visible = false;
					for (let row = y; row < y + height; row++) {
						const start = 4 * (row * texture.width + x);
						for (let i = start + 3; i < start + width * 4; i += 4) visible ||= pixels[i] !== 0;
					}
					const openRibcage = id === "minecraft:skeleton" && bone.name === "body" && x === u + d && y === v;
					assert.equal(visible, !openRibcage, `${bone.name} face at ${x},${y}`);
				}
			}
		}
		const peaks = Object.values(walkPitch);
		assert.ok(peaks.some(p => (p ?? 0) > 0) && peaks.some(p => (p ?? 0) < 0));
		for (const [name, degrees] of Object.entries(walkPitch)) {
			assert.ok(names.has(name) && Number.isFinite(degrees), `invalid walk channel for ${name}`);
		}
	});
}

test("undead faces have a light brow above two one-texel-high dark eyes", () => {
	for (const id of ["minecraft:zombie", "minecraft:skeleton"]) {
		const { texture } = mobAssets.get(id)!;
		const pixels = texture.pixels();
		const green = (x: number, y: number) => pixels[(y * texture.width + x) * 4 + 1];
		// Head front starts at (8, 8). The dark eyes sit in the fifth row.
		for (const x of [9, 10, 13, 14]) {
			assert.ok(green(x, 12) + 55 < green(x, 11), id);
			assert.ok(green(x, 12) + 55 < green(x, 13), id);
		}
	}
});

test("adult zombie extends both arms and the idle skeleton grips a bow in its right hand", () => {
	const zombie = mobAssets.get("minecraft:zombie")!;
	for (const name of ["rightArm", "leftArm"]) {
		assert.equal(zombie.bones.find(b => b.name === name)?.rotation?.[0], -90);
	}
	const skeleton = mobAssets.get("minecraft:skeleton")!;
	const socket = skeleton.bones.find(b => b.name === "rightItem");
	assert.equal(socket?.parent, "rightArm");
	assert.equal(skeleton.bones.find(b => b.name === "rightArm")?.rotation?.[0], -18);
	const held = skeleton.bones.find(b => b.parent === socket?.name)?.itemSprite;
	assert.ok(held);
	assert.equal(held.texture, "bow");
	const pixels = packTile(held.texture)!;
	const [u, v] = held.grip.map(Math.floor);
	assert.equal(pixels[4 * (v * 16 + u) + 3], 255, "the grip must lie on the bow");
});
