import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mobAssets } from "./catalog.ts";
import { itemTexture } from "../item-textures.ts";

test("adult mob visuals can be looked up by Bedrock identifier", () => {
	for (const name of ["pig", "cow", "chicken", "sheep", "zombie", "skeleton", "creeper", "husk", "stray"]) {
		const id = `minecraft:${name}`;
		assert.equal(mobAssets.get(id)?.id, id);
	}
	assert.equal(mobAssets.get("minecraft:unknown"), undefined);
});

// PNGs from Bedrock Samples v1.26.60.5. Sheep is the white-fleece conversion of sheep.tga.
const fingerprints: Record<string, string> = {
	"minecraft:stray": "5dcb0c2ab92826a6a4f4d35fd7dc6891a8c9b620ad03cdcd813a6911566edc8a",
	"minecraft:husk": "461af7ce595331d0e5d4d1a60ba28eedcb222ee7e43c4a50cd4545653f6e9ba0",
	"minecraft:chicken": "487a9bed72731b586bbbd365b78320fbe04e4c44aeb840e7d2f3a828a0906c9d",
	"minecraft:cow": "7b8ceb1ab4d202a17318351110b7f2fd55f6948758094e5a4abc0899aa5e5749",
	"minecraft:creeper": "de7cb032dc9a81732535c66aaf55dba03e29a4463219403d6d9573018191790a",
	"minecraft:pig": "4e2891d9e7d7ac592c911a43c419e9bc6c91918fad3c45a1e8db2021b5553f0d",
	"minecraft:sheep": "9dc17a0b20d07186bd58d3c72e6a05ce44621dbdbc58c8368616cdd55cd2a456",
	"minecraft:skeleton": "850d5eb0178465c2661e5bf0bde5d9485f8de23c4a75590205acc968f7e000b1",
	"minecraft:zombie": "b172ff1b50c3ce0587cf82a2865bb05b9a22fc54a78d446b7bfcab13ffcea0ab",
};

for (const [id, { bones, texture, walkPitch }] of mobAssets) {
	test(`${id} has the expected box UVs and a bone for every walk channel`, () => {
		const png = readFileSync(texture.url);
		assert.equal(createHash("sha256").update(png).digest("hex"), fingerprints[id]);
		assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [texture.width, texture.height]);
		const names = new Set<string>();
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
			}
		}
		const peaks = Object.values(walkPitch);
		assert.ok(peaks.some(p => (p ?? 0) > 0) && peaks.some(p => (p ?? 0) < 0));
		for (const [name, degrees] of Object.entries(walkPitch)) {
			assert.ok(names.has(name) && Number.isFinite(degrees), `invalid walk channel for ${name}`);
		}
	});
}

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
	const pixels = itemTexture(held.texture)!;
	const [u, v] = held.grip.map(Math.floor);
	assert.equal(pixels[4 * (v * 16 + u) + 3], 255, "the grip must lie on the bow");
});
