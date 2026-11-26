import assert from "node:assert/strict";
import { test } from "node:test";
import { entityNames, entityPoses, skeletonBow } from "./catalog.ts";
import { cubeFaces, geometryDefinitions, resolveGeometry, type MobCube } from "./model.ts";
import { decodedFixturePack } from "../../../test/texture-pack-fixture.mjs";

const fixture = await decodedFixturePack();

test("game entity keys resolve assets through fixture client descriptions", () => {
	for (const name of entityNames) assert.ok(fixture.entities.get(name), name);
	assert.equal(fixture.entities.size, entityNames.length + 1);
	assert.equal(fixture.entities.has("unknown" as never), false);
	assert.deepEqual([...fixture.entities.values()].map(({ texture }) => texture.pixels.length),
		[64 * 64, 64 * 64, 64 * 32, 64 * 80, 64 * 80, 64 * 32, 64 * 32, 64 * 32, 64 * 32].map(area => area * 4));
});

for (const name of entityNames) {
	test(`${name} has visible pixels in its face rectangles and bones for its walk channels`, () => {
		const { bones, uvWidth, uvHeight, texture } = fixture.entities.get(name)!;
		assert.deepEqual([uvWidth, uvHeight], [texture.width, texture.height]);
		const names = new Set<string>();
		for (const bone of bones) {
			assert.ok(!names.has(bone.name), `duplicate ${bone.name}`);
			if (bone.parent) assert.ok(names.has(bone.parent), `missing parent for ${bone.name}`);
			names.add(bone.name);
			assert.ok([...bone.pivot, ...(bone.rotation ?? [])].every(Number.isFinite));
			for (const cube of bone.cubes ?? []) {
				assert.ok(cube.origin.every(Number.isFinite));
				assert.ok(cube.size.every(n => Number.isFinite(n) && n > 0));
				for (const [face, rect] of cubeFaces(cube, bone.mirror).entries()) {
					assert.ok(rect);
					const [x, y, w, h] = rect;
					const left = Math.min(x, x + w), right = Math.max(x, x + w);
					const top = Math.min(y, y + h), bottom = Math.max(y, y + h);
					assert.ok(left >= 0 && right <= uvWidth && top >= 0 && bottom <= uvHeight);
					let visible = false;
					for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
						visible ||= texture.pixels[(row * texture.width + col) * 4 + 3] !== 0;
					}
					const openRibcage = name === "skeleton" && bone.name === "body" && face === 4;
					assert.equal(visible, !openRibcage, `${bone.name} face at ${x},${y}`);
				}
			}
		}
		const { walkPitch } = entityPoses[name];
		const peaks = Object.values(walkPitch);
		assert.ok(peaks.some(p => (p ?? 0) > 0) && peaks.some(p => (p ?? 0) < 0));
		for (const [bone, degrees] of Object.entries(walkPitch)) {
			assert.ok(names.has(bone) && Number.isFinite(degrees), `invalid walk channel for ${bone}`);
		}
	});
}

test("fixture undead eyes are visibly darker than the brow and cheeks", () => {
	for (const name of ["zombie", "skeleton"] as const) {
		const { texture } = fixture.entities.get(name)!;
		const green = (x: number, y: number) => texture.pixels[(y * texture.width + x) * 4 + 1];
		for (const x of [9, 10, 13, 14]) {
			assert.ok(green(x, 12) + 55 < green(x, 11), name);
			assert.ok(green(x, 12) + 55 < green(x, 13), name);
		}
	}
});

test("adult zombie extends both arms and the idle skeleton grips a pack bow in its right hand", () => {
	for (const name of ["rightArm", "leftArm"]) {
		assert.equal(entityPoses.zombie.restRotation?.[name]?.[0], -90);
	}
	const skeleton = fixture.entities.get("skeleton")!;
	const socket = skeleton.bones.find(b => b.name === skeletonBow.bone);
	assert.equal(socket?.parent, "rightArm");
	assert.equal(entityPoses.skeleton.restRotation?.rightArm?.[0], -18);
	const pixels = fixture.tiles.get(skeletonBow.texture)!;
	const [u, v] = skeletonBow.grip.map(Math.floor);
	assert.equal(pixels[4 * (v * 16 + u) + 3], 255, "the grip must lie on the bow");
});

test("box UV mirror swaps sides and reverses U, with cube mirror taking precedence", () => {
	const cube: MobCube = { origin: [0, 0, 0], size: [2, 3, 4], uv: [1, 2] };
	assert.deepEqual(cubeFaces(cube), [[1, 6, 4, 3], [5, 6, 2, 3], [7, 6, 4, 3],
		[11, 6, 2, 3], [5, 2, 2, 4], [7, 2, 2, 4]]);
	assert.deepEqual(cubeFaces(cube, true), [[11, 6, -4, 3], [7, 6, -2, 3], [5, 6, -4, 3],
		[13, 6, -2, 3], [7, 2, -2, 4], [9, 2, -2, 4]]);
	assert.deepEqual(cubeFaces({ ...cube, mirror: false }, true), cubeFaces(cube));
});

test("explicit zero UV rotation is equivalent to omission and other rotations stay unsupported", () => {
	const { texture } = fixture.entities.get("cow")!;
	const resolve = (uv_rotation?: number) => resolveGeometry("geometry.test", new Map([["geometry.test", {
		width: 16, height: 16,
		bones: [{ name: "body", cubes: [{ origin: [0, 0, 0], size: [2, 2, 2], uv: { north: { uv: [0, 0], uv_rotation } } }] }],
	}]]), texture);
	const omitted = resolve(), zero = resolve(0);
	assert.ok(omitted && zero);
	assert.deepEqual(cubeFaces(zero.bones[0].cubes![0]), cubeFaces(omitted.bones[0].cubes![0]));
	for (const rotation of [90, 180, 270, 360]) assert.equal(resolve(rotation), undefined);
});

test("geometry requires a defined face with positive area after inflation", () => {
	const { texture } = fixture.entities.get("cow")!;
	const resolve = (size: MobCube["size"], face: string, inflate = 0) =>
		resolveGeometry("geometry.test", new Map([["geometry.test", {
			width: 16, height: 16,
			bones: [{ name: "body", rotation: [90, 0, 0], inflate,
				cubes: [{ origin: [0, 0, 0], size, uv: { [face]: { uv: [0, 0], uv_size: [2, 2] } } }] }],
		}]]), texture);
	assert.equal(resolve([0, 2, 2], "north"), undefined);
	assert.equal(resolve([2, 2, 4], "north", -1), undefined);
	assert.ok(resolve([0, 2, 2], "north", 1));
	assert.ok(resolve([2, 2, 0], "north"));
	assert.ok(resolve([0, 2, 2], "west"));
	assert.ok(resolve([2, 0, 2], "up"));
});

test("legacy inheritance retains base and added cubes and rejects a missing or cyclic base", () => {
	const { bones: baseBones, texture } = fixture.entities.get("sheep/sheared")!;
	const { bones } = fixture.entities.get("sheep")!;
	assert.ok(bones.some(b => b.name === "head" && b.cubes?.length === 1));
	assert.equal(bones.find(b => b.name === "body")?.cubes?.length, 3);
	assert.deepEqual(bones.find(b => b.name === "body")?.cubes?.[0], baseBones.find(b => b.name === "body")?.cubes?.[0]);
	assert.equal(bones.find(b => b.name === "leg2")?.parent, "root");
	for (const model of [
		{ "geometry.child:geometry.base": { bones } },
		{ "geometry.child:geometry.base": { bones }, "geometry.base:geometry.child": { bones } },
	]) assert.equal(resolveGeometry("geometry.child", geometryDefinitions(model), texture), undefined);
});
