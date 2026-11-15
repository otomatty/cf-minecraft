import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClientCore, type RayHit } from "./client-core.ts";
import { placementState } from "./placement.ts";
import { defaultHotbar, HOTBAR_KEY, loadHotbar, saveHotbar } from "./hotbar.ts";

const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
const registry = core.blockRegistry();
const id = (name: string) => registry.findIndex(b => b.stateName === name || b.name === name);
const slab = id("oak_slab");
const air = id("air");
const stone = id("stone");
const hit = (face: number, hitY = 0.25): RayHit => ({ x: 0, y: -2, z: 0, face, hitY, min: [0, 0, 0], max: [1, 1, 1] });
const world = (target = stone, adjacent = air, support = stone) => (x: number, y: number, z: number) => {
	if (x === 0 && y === -2 && z === 0) return target;
	if (y === -3) return support;
	return adjacent;
};

test("WASM registry exposes contiguous state ranges, names, defaults and occlusion", () => {
	assert.equal(registry.length, 23);
	assert.equal(slab, 14);
	assert.equal(registry[slab + 1].stateName, "oak_slab[type=top]");
	assert.equal(registry[slab + 2].occludes, true);
	assert.equal(registry[slab].occludes, false);
	assert.equal(registry[id("short_grass")].model, "cross");
	for (const [state, info] of registry.entries()) {
		assert.ok(state >= info.first && state < info.first + info.count);
		assert.equal(registry[info.first].name, info.name);
		assert.ok(core.textureNames().includes(info.texture));
	}
});

test("slab orientation uses the face and exact local hit Y, including negative world Y", () => {
	for (const base of [slab, id("cobblestone_slab")]) {
		for (const [face, y, offset] of [[1, 1, 0], [0, 0, 1], [2, 0.499999, 0], [2, 0.5, 1], [3, 0.8, 1], [4, 0.2, 0], [5, 1, 1]]) {
			assert.equal(placementState(registry, base, hit(face, y), world(stone, air, air))?.state, base + offset);
		}
	}
});

test("only the open horizontal slab face merges the hit block", () => {
	for (const [target, face] of [[slab, 1], [slab + 1, 0]]) {
		assert.deepEqual(placementState(registry, slab, hit(face), world(target)), { x: 0, y: -2, z: 0, state: slab + 2 });
	}
	const side = placementState(registry, slab, hit(5), world(slab));
	assert.deepEqual(side, { x: 1, y: -2, z: 0, state: slab });
	assert.equal(placementState(registry, id("cobblestone_slab"), hit(1), world(slab))?.state, id("cobblestone_slab"));
	assert.equal(placementState(registry, slab, hit(1), world(slab + 2))?.y, -1);
});

test("adjacent slabs merge only when the same kind has the requested empty half", () => {
	assert.equal(placementState(registry, slab, hit(5, 0.75), world(stone, slab))?.state, slab + 2);
	assert.equal(placementState(registry, slab, hit(5, 0.25), world(stone, slab + 1))?.state, slab + 2);
	for (const [current, y] of [[slab, 0.25], [slab + 1, 0.75], [slab + 2, 0.25], [id("cobblestone_slab"), 0.75], [stone, 0.25]]) {
		assert.equal(placementState(registry, slab, hit(5, y), world(stone, current)), null);
	}
});

test("ordinary placement replaces air or water, and rejects occupied or unloaded cells", () => {
	for (const current of [air, id("water")]) assert.equal(placementState(registry, stone, hit(5), world(stone, current))?.state, stone);
	for (const current of [stone, slab, id("red_flower"), -1]) assert.equal(placementState(registry, stone, hit(5), world(stone, current)), null);
	assert.equal(placementState(registry, -1, hit(5), world()), null);
	assert.equal(placementState(registry, stone, hit(-1), world()), null);
});

test("plants require an occluding block directly beneath the destination", () => {
	for (const name of ["red_flower", "yellow_flower", "short_grass"]) {
		for (const support of [stone, slab + 2]) assert.equal(placementState(registry, id(name), hit(5), world(stone, air, support))?.state, id(name));
		for (const support of [air, slab, slab + 1, id("glass"), id("water"), -1]) assert.equal(placementState(registry, id(name), hit(5), world(stone, air, support)), null);
	}
});

test("hotbar defaults include slabs; names round trip and restore block defaults", () => {
	const values = new Map<string, string>();
	const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
	const defaults = defaultHotbar(registry);
	assert.equal(defaults.length, 9);
	assert.equal(defaults[3], slab);
	assert.deepEqual(loadHotbar(storage, registry), defaults);
	const slots = [...defaults];
	slots[3] = slab + 1;
	slots[0] = id("red_flower");
	assert.equal(saveHotbar(storage, slots, registry), true);
	assert.deepEqual(JSON.parse(values.get(HOTBAR_KEY)!), slots.map(state => registry[state].name));
	assert.deepEqual(loadHotbar(storage, registry), slots.map(state => registry[state].first));
	const duplicate = Array(9).fill(slab);
	assert.equal(saveHotbar(storage, duplicate, registry), true);
	assert.deepEqual(loadHotbar(storage, registry), duplicate);
});

test("corrupt hotbars and denied storage use fresh defaults without throwing", () => {
	for (const data of ["{", "null", "{}", "[]", JSON.stringify(Array(8).fill("stone")), JSON.stringify(Array(9).fill("air")), JSON.stringify(Array(9).fill(1)), JSON.stringify(Array(9).fill("missing")), JSON.stringify(Array(9).fill("oak_slab[type=top]"))]) {
		assert.deepEqual(loadHotbar({ getItem: () => data }, registry), defaultHotbar(registry));
	}
	assert.deepEqual(loadHotbar({ getItem() { throw new Error("denied"); } }, registry), defaultHotbar(registry));
	assert.equal(saveHotbar({ setItem() { throw new Error("quota"); } }, defaultHotbar(registry), registry), false);
	const first = defaultHotbar(registry);
	first[0] = air;
	assert.equal(defaultHotbar(registry)[0], stone);
});
