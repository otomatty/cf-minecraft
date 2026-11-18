import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ClientCore, type RayHit } from "./client-core.ts";
import { paintTexture } from "./textures.ts";
import { blockIconPixels, ICON_SIZE } from "./block-icon.ts";
import { blockInteraction, bucketTarget, canTill, placementState } from "./placement.ts";
import { hotbarStates, pickBlockItem } from "./hotbar.ts";

const core = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
const registry = core.blockRegistry();
const id = (name: string) => registry.findIndex(b => b.stateName === name || b.name === name);
const slab = id("oak_slab");
const air = id("air");

test("pick block finds the same item for both leaves and places persistent leaves", () => {
	const items = core.itemRegistry();
	const natural = registry[id("oak_leaves")];
	const placed = registry[id("placed_oak_leaves")];
	const leaves = items.find(item => item.name === "oak_leaves");
	assert.ok(leaves);
	assert.equal(pickBlockItem(natural, items), leaves);
	assert.equal(pickBlockItem(placed, items), leaves);
	assert.equal(hotbarStates([{ item: leaves.id }], items)[0], placed.first);
	assert.equal(pickBlockItem(registry[id("stone")], items)?.name, "stone");
	assert.equal(pickBlockItem(registry[slab + 1], items)?.name, "oak_slab");
	assert.equal(pickBlockItem(registry[air], items), undefined);
});

test("inventory icons use registered faces and distinguish blocks built from the same material", () => {
	const atlas = new Map(core.textureNames().map(name => [name, paintTexture(name)]));
	const missing = paintTexture("missing");
	for (const [name, pixels] of atlas) assert.notDeepEqual(pixels, missing, name);
	const icon = name => blockIconPixels(registry[id(name)], atlas);
	const coverage = name => icon(name).filter((value, i) => i % 4 === 3 && value !== 0).length;
	assert.deepEqual(registry[id("sandstone")].faces, ["sandstone_bottom", "sandstone_top", ...Array(4).fill("sandstone")]);
	assert.deepEqual(registry[id("oak_log")].faces, ["oak_log_top", "oak_log_top", ...Array(4).fill("oak_log")]);
	assert.deepEqual(registry[id("water")].faces, ["water", "water", ...Array(4).fill("water_flow")]);
	assert.ok(coverage("oak_fence") < coverage("oak_slab"));
	assert.ok(coverage("oak_slab") < coverage("oak_stairs"));
	assert.ok(coverage("oak_stairs") < coverage("oak_planks"));
	for (const block of registry.filter(b => b.name !== "air")) {
		const pixels = blockIconPixels(block, atlas);
		assert.equal(pixels.length, ICON_SIZE * ICON_SIZE * 4);
		assert.ok(pixels.some((value, i) => i % 4 === 3 && value > 0), block.stateName);
	}
});
const stone = id("stone");
const hit = (face: number, hitY = 0.25): RayHit => ({ x: 0, y: -2, z: 0, face, hitY, min: [0, 0, 0], max: [1, 1, 1] });
const world = (target = stone, adjacent = air, support = stone) => (x: number, y: number, z: number) => {
	if (x === 0 && y === -2 && z === 0) return target;
	if (y === -3) return support;
	return adjacent;
};

test("WASM registry exposes contiguous state ranges, names, defaults and occlusion", () => {
	assert.equal(registry.length, 70);
	assert.equal(id("water"), 13);
	for (const [i, level] of [1, 2, 3, 4, 5, 6, 7, "falling"].entries()) {
		const state = id(`flowing_water[level=${level}]`);
		assert.equal(state, 62 + i);
		assert.equal(registry[state].first, 62);
		assert.equal(registry[state].count, 8);
		assert.equal(registry[state].occludes, false);
	}
	assert.equal(id("crafting_table"), 49);
	assert.equal(id("furnace"), 50);
	assert.equal(slab, 14);
	assert.equal(registry[slab + 1].stateName, "oak_slab[type=top]");
	assert.equal(registry[slab + 2].occludes, true);
	assert.equal(registry[slab].occludes, false);
	assert.equal(registry[id("short_grass")].model, "cross");
	for (const [name, first] of [["oak_stairs", 23], ["cobblestone_stairs", 31]] as const) {
		assert.equal(id(name), first);
		for (const [f, facing] of ["north", "south", "west", "east"].entries()) {
			for (const [h, half] of ["bottom", "top"].entries()) {
				const info = registry[first + f * 2 + h];
				assert.equal(info.stateName, `${name}[facing=${facing},half=${half}]`);
				assert.equal(info.first, first);
				assert.equal(info.count, 8);
				assert.equal(info.model, "stairs");
				assert.equal(info.occludes, false);
			}
		}
	}
	assert.equal(id("oak_fence"), 39);
	assert.equal(registry[39].count, 1);
	assert.equal(registry[39].model, "fence");
	assert.equal(registry[39].occludes, false);
	for (const [state, info] of registry.entries()) {
		assert.ok(state >= info.first && state < info.first + info.count);
		assert.equal(registry[info.first].name, info.name);
		assert.ok(core.textureNames().includes(info.texture));
	}
});

test("slab orientation uses the face and exact local hit Y, including negative world Y", () => {
	for (const base of [slab, id("cobblestone_slab")]) {
		for (const [face, y, offset] of [[1, 1, 0], [0, 0, 1], [2, 0.499999, 0], [2, 0.5, 1], [3, 0.8, 1], [4, 0.2, 0], [5, 1, 1]]) {
			assert.equal(placementState(registry, base, hit(face, y), 0, world(stone, air, air))?.state, base + offset);
		}
	}
});

test("stair facing follows yaw through all quadrant boundaries and wraps", () => {
	for (const base of [id("oak_stairs"), id("cobblestone_stairs")]) {
		const cases: [number, string][] = [
			[0, "south"], [90, "west"], [180, "north"], [270, "east"],
			[45 - 0.000001, "south"], [45, "west"], [45 + 0.000001, "west"],
			[135 - 0.000001, "west"], [135, "north"], [135 + 0.000001, "north"],
			[225 - 0.000001, "north"], [225, "east"], [225 + 0.000001, "east"],
			[315 - 0.000001, "east"], [315, "south"], [315 + 0.000001, "south"],
		];
		for (const [yaw, facing] of cases) for (const turns of [-2, -1, 0, 1, 2]) {
			const edit = placementState(registry, base, hit(1, 1), yaw + turns * 360, world());
			assert.equal(edit?.state, id(`${registry[base].name}[facing=${facing},half=bottom]`), `yaw=${yaw + turns * 360}`);
		}
		for (const yaw of [NaN, Infinity, -Infinity]) {
			assert.equal(placementState(registry, base, hit(1), yaw, world()), null);
		}
	}
});

test("stair half uses the hit face and local Y, independently of facing", () => {
	const cases: [number, number, "top" | "bottom"][] = [
		[0, 0, "top"], [0, 1, "top"], [1, 0, "bottom"], [1, 1, "bottom"],
	];
	for (const face of [2, 3, 4, 5]) {
		cases.push([face, 0, "bottom"], [face, 0.499999, "bottom"], [face, 0.5, "top"], [face, 1, "top"]);
	}
	for (const name of ["oak_stairs", "cobblestone_stairs"]) {
		for (const [yaw, facing] of [[0, "south"], [90, "west"], [180, "north"], [270, "east"]] as const) {
			for (const [face, y, half] of cases) {
				// A selected non-default state must still use this placement's yaw/half.
				const edit = placementState(registry, id(name) + 7, hit(face, y), yaw, world(stone, air, air));
				assert.equal(edit?.state, id(`${name}[facing=${facing},half=${half}]`));
			}
		}
	}
});

test("stairs and fences replace only air or water and never merge", () => {
	for (const name of ["oak_stairs", "cobblestone_stairs", "oak_fence"]) {
		const selected = id(name);
		for (const current of [air, id("water")]) {
			assert.deepEqual(placementState(registry, selected, hit(1), 180, world(stone, current, air)),
				{ x: 0, y: -1, z: 0, state: selected });
		}
		for (const current of [stone, slab, selected, selected + (name === "oak_fence" ? 0 : 1), id("red_flower"), -1]) {
			assert.equal(placementState(registry, selected, hit(1), 180, world(stone, current)), null);
		}
	}
	for (const face of [0, 1, 2, 3, 4, 5]) {
		assert.equal(placementState(registry, id("oak_fence"), hit(face, 0.75), 270, world(stone, air, air))?.state, id("oak_fence"));
	}
});

test("only the open horizontal slab face merges the hit block", () => {
	for (const [target, face] of [[slab, 1], [slab + 1, 0]]) {
		assert.deepEqual(placementState(registry, slab, hit(face), 0, world(target)), { x: 0, y: -2, z: 0, state: slab + 2 });
	}
	const side = placementState(registry, slab, hit(5), 0, world(slab));
	assert.deepEqual(side, { x: 1, y: -2, z: 0, state: slab });
	assert.equal(placementState(registry, id("cobblestone_slab"), hit(1), 0, world(slab))?.state, id("cobblestone_slab"));
	assert.equal(placementState(registry, slab, hit(1), 0, world(slab + 2))?.y, -1);
});

test("adjacent slabs merge only when the same kind has the requested empty half", () => {
	assert.equal(placementState(registry, slab, hit(5, 0.75), 0, world(stone, slab))?.state, slab + 2);
	assert.equal(placementState(registry, slab, hit(5, 0.25), 0, world(stone, slab + 1))?.state, slab + 2);
	for (const [current, y] of [[slab, 0.25], [slab + 1, 0.75], [slab + 2, 0.25], [id("cobblestone_slab"), 0.75], [stone, 0.25]]) {
		assert.equal(placementState(registry, slab, hit(5, y), 0, world(stone, current)), null);
	}
});

test("ordinary placement replaces air or water, and rejects occupied or unloaded cells", () => {
	for (const current of [air, id("water")]) assert.equal(placementState(registry, stone, hit(5), 0, world(stone, current))?.state, stone);
	for (const current of [stone, slab, id("red_flower"), -1]) assert.equal(placementState(registry, stone, hit(5), 0, world(stone, current)), null);
	assert.equal(placementState(registry, -1, hit(5), 0, world()), null);
	assert.equal(placementState(registry, stone, hit(-1), 0, world()), null);
});

test("plants require an occluding block directly beneath the destination", () => {
	for (const name of ["red_flower", "yellow_flower", "short_grass"]) {
		for (const support of [stone, slab + 2]) assert.equal(placementState(registry, id(name), hit(5), 0, world(stone, air, support))?.state, id(name));
		for (const support of [air, slab, slab + 1, id("glass"), id("water"), -1]) assert.equal(placementState(registry, id(name), hit(5), 0, world(stone, air, support)), null);
	}
});

test("hotbar mirrors authoritative items including default slab block states", () => {
	const items = [{ id: 101, block: stone }, { id: 102, block: slab }];
	const slots = Array.from({ length: 36 }, () => null as { item: number; count: number } | null);
	slots[0] = { item: 101, count: 64 };
	slots[3] = { item: 102, count: 2 };
	slots[9] = { item: 101, count: 1 };
	assert.deepEqual(hotbarStates(slots, items), [stone, 0, 0, slab, 0, 0, 0, 0, 0]);
	assert.equal(slots[0]?.count, 64);
});

test("empty, unknown and non-block items have empty hotbar icons", () => {
	const items = [{ id: 8, block: null }, { id: 9, block: stone }];
	const slots = [{ item: 8 }, { item: 65535 }, null, { item: 9 }, ...Array(32).fill(null)];
	const states = hotbarStates(slots, items);
	assert.deepEqual(states, [0, 0, 0, stone, 0, 0, 0, 0, 0]);
	states[3] = air;
	assert.equal(hotbarStates(slots, items)[3], stone);
});


test("biome blocks expose picker entries and original art, with translucent ice", () => {
	for (const [index, name] of ["snow_block", "sandstone", "gravel", "ice", "coarse_dirt"].entries()) {
		const state = id(name);
		assert.equal(state, 40 + index);
		assert.equal(registry[state].model, "cube");
		assert.equal(registry[state].first, state);
		const pixels = paintTexture(name);
		assert.deepEqual(pixels, paintTexture(name));
		assert.equal(pixels.length, 16 * 16 * 4);
		for (let i = 0; i < pixels.length; i += 4) {
			assert.ok(pixels[i + 1] > 0, "no missing-texture magenta/black");
			assert.ok(name === "ice" ? pixels[i+3] > 0 && pixels[i+3] < 255 : pixels[i+3] === 255);
		}
	}
});


test("WASM mining rules use the selected tool, tier gates and integer rounding", () => {
	const item = (name: string) => core.itemRegistry().find(item => item.name === name)!.id;
	for (const [block, held, ticks, drops] of [
		["stone", 0, 140, false],
		["stone", item("wooden_pickaxe"), 35, true],
		["stone", item("iron_axe"), 140, false],
		["gold_ore", item("stone_pickaxe"), 46, false],
		["gold_ore", item("copper_pickaxe"), 18, true],
		["grass_block", item("iron_shovel"), 3, true],
		["red_flower", item("iron_shovel"), 0, true],
		["bedrock", 0, null, false],
	] as const) {
		assert.equal(core.miningTicks(id(block), held), ticks);
		assert.equal(core.miningDrops(id(block), held), drops);
	}
	assert.equal(core.miningTicks(65535, 0), null);
});


test("right-click opens a crafting table unless Shift requests placement", () => {
    assert.equal(blockInteraction("crafting_table", false), "open");
    assert.equal(blockInteraction("crafting_table", true), "place");
    for (const name of ["stone", "oak_log", "air", undefined]) {
        assert.equal(blockInteraction(name, false), "place");
        assert.equal(blockInteraction(name, true), "place");
    }
});

test("right-click opens a furnace unless Shift requests placement", () => {
    assert.equal(blockInteraction("furnace", false), "open");
    assert.equal(blockInteraction("furnace", true), "place");
});

test("wheat seeds require air above either farmland state and plant at age zero", () => {
	const seed = core.itemRegistry().find(item => item.name === "wheat_seeds");
	const wheat = id("wheat[age=0]");
	assert.equal(seed?.block, wheat);
	for (const moist of ["false", "true"]) {
		const farmland = id(`farmland[moist=${moist}]`);
		for (const current of [id("water"), id("short_grass"), wheat, -1]) {
			assert.equal(placementState(registry, wheat, hit(1), 0, world(farmland, current)), null);
		}
		assert.deepEqual(placementState(registry, wheat, hit(1), 0, world(farmland)), { x: 0, y: -1, z: 0, state: wheat });
		assert.equal(placementState(registry, wheat + 7, hit(1), 0, world(farmland))?.state, wheat);
	}
	for (const below of [stone, id("grass_block"), id("dirt"), air, -1]) {
		assert.equal(placementState(registry, wheat, hit(1), 0, world(below)), null);
	}
});

test("right-click tills uncovered grass or dirt with any hoe", () => {
	for (const tier of ["wooden", "stone", "copper", "iron"]) {
		for (const ground of ["grass_block", "dirt"]) {
			assert.equal(canTill(`${tier}_hoe`, ground, "air"), true);
			for (const cover of ["stone", "glass", "water", undefined]) {
				assert.equal(canTill(`${tier}_hoe`, ground, cover), false);
			}
		}
	}
	for (const item of [undefined, "wooden_shovel", "wheat_seeds"]) assert.equal(canTill(item, "dirt", "air"), false);
	for (const ground of ["stone", "farmland", "crafting_table", "furnace", undefined]) {
		assert.equal(canTill("iron_hoe", ground, "air"), false);
	}
});

test("crop states and farming items use distinct painted textures", () => {
	const crops = registry.filter(block => block.name === "wheat");
	assert.deepEqual(crops.map(block => block.stateName), Array.from({ length: 8 }, (_, age) => `wheat[age=${age}]`));
	assert.deepEqual(crops.map(block => block.texture), [
		"wheat_sprout", "wheat_sprout", "wheat_shoot", "wheat_shoot",
		"wheat_green", "wheat_green", "wheat_green", "wheat_ripe",
	]);
	assert.notDeepEqual(paintTexture("farmland_dry"), paintTexture("farmland_moist"));
	for (const name of ["wooden_hoe", "stone_hoe", "copper_hoe", "iron_hoe", "wheat_seeds", "wheat", "bread"]) {
		assert.equal(core.itemRegistry().find(item => item.name === name)?.texture, name);
		const pixels = paintTexture(name);
		assert.ok(pixels.some((value, i) => i % 4 === 3 && value === 0), name);
		assert.ok(pixels.some((value, i) => i % 4 === 3 && value === 255), name);
	}
});

test("empty bucket targets only the source hit by the water-inclusive ray", () => {
	const target = hit(1);
	for (const name of ["flowing_water", "glass", "air", undefined]) {
		assert.equal(bucketTarget("bucket", target, () => name, false), null);
	}
	assert.equal(bucketTarget("bucket", null, () => "water", false), null);
	assert.deepEqual(bucketTarget("bucket", target, () => "water", false), [0, -2, 0]);
	assert.deepEqual([...core.encodeUseBucket(-1, -2, 3)], [15, 255, 255, 255, 255, 255, 255, 255, 254, 0, 0, 0, 3]);
});

test("filled bucket targets the adjacent air or flow and respects block interaction", () => {
	const target = hit(5);
	for (const name of ["air", "flowing_water"]) {
		assert.deepEqual(bucketTarget("water_bucket", target, x => x === 0 ? "stone" : name, false), [1, -2, 0]);
	}
	for (const name of ["water", "glass", "short_grass", undefined]) {
		assert.equal(bucketTarget("water_bucket", target, x => x === 0 ? "stone" : name, false), null);
	}
	for (const name of ["crafting_table", "furnace"]) {
		const blockName = x => x === 0 ? name : "air";
		assert.equal(bucketTarget("water_bucket", target, blockName, false), null);
		assert.deepEqual(bucketTarget("water_bucket", target, blockName, true), [1, -2, 0]);
	}
	assert.equal(bucketTarget("water_bucket", null, () => "air", false), null);
	const flow = registry[id("flowing_water[level=1]")];
	assert.equal(pickBlockItem(flow, core.itemRegistry()), undefined);
	assert.deepEqual(placementState(registry, id("stone"), target, 0, x => x === 0 ? id("stone") : flow.first),
		{ x: 1, y: -2, z: 0, state: id("stone") });
	assert.notDeepEqual(paintTexture("bucket"), paintTexture("water_bucket"));
});
