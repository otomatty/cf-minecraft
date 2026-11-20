import assert from "node:assert/strict";
import { test } from "node:test";
import { arrowHitPosition, arrowStopped, blockSound, creeperIgnited, distanceGain, materialFor, MAX_VOICES,
	mobRemovalSound, playerSounds, soundGain, spatialSound, voicesToStop } from "./events.ts";
import { musicPlan } from "./music.ts";
import type { ArrowEntity } from "../client-core.ts";

test("material follows the block name, including the current registry variants", () => {
	for (const [material, names] of Object.entries({
		stone: ["stone", "cobblestone_stairs", "sandstone", "iron_ore", "obsidian"],
		wood: ["oak_planks", "oak_log", "oak_slab", "oak_fence", "crafting_table"],
		earth: ["grass_block", "dirt", "coarse_dirt", "farmland"],
		sand: ["sand", "gravel", "snow_block"],
		glass: ["glass", "ice"],
		wool: ["white_wool"],
		plant: ["oak_leaves", "placed_oak_leaves", "red_flower", "short_grass", "wheat"],
		water: ["water", "flowing_water"],
		lava: ["lava", "flowing_lava"],
	})) {
		for (const name of names) assert.equal(materialFor(name), material, name);
	}
});

test("block sounds use the removed or placed material and ignore unloaded and flowing states", () => {
	assert.deepEqual(blockSound("oak_leaves", "air"), { kind: "break", material: "plant" });
	assert.deepEqual(blockSound("air", "oak_log"), { kind: "place", material: "wood" });
	assert.deepEqual(blockSound("water", "glass"), { kind: "place", material: "glass" });
	assert.deepEqual(blockSound("air", "lava"), { kind: "place", material: "lava" });
	assert.equal(blockSound("stone", "stone"), null);
	assert.equal(blockSound(undefined, "stone"), null);
	assert.equal(blockSound("air", "flowing_water"), null);
	assert.equal(blockSound("flowing_lava", "air"), null);
});

test("distance and both volume controls multiply and sources beyond 32 blocks are silent", () => {
	const volumes = { master: 80, effects: 50, music: 60 };
	assert.equal(soundGain(volumes, "effects", 0), 0.4);
	assert.equal(soundGain(volumes, "effects", 16), 0.2);
	assert.equal(soundGain(volumes, "music"), 0.48);
	assert.equal(soundGain({ ...volumes, music: 0 }, "music"), 0);
	assert.equal(soundGain({ ...volumes, master: 0 }, "effects"), 0);
	assert.ok(distanceGain(31.99) > 0);
	assert.equal(distanceGain(32), 0);
	assert.equal(soundGain(volumes, "effects", 40), 0);
	const camera = { x: 0, y: 0, z: 0, yaw: 0 };
	assert.deepEqual(spatialSound(camera, [-16, 0, 0]), { pan: 1, distance: 16 });
	assert.deepEqual(spatialSound(camera, [0, 32, 0]), { pan: 0, distance: 32 });
	assert.equal(spatialSound({ ...camera, yaw: 180 }, [-16, 0, 0]).pan, -1);
});

test("the oldest voice must be discarded before starting the 25th effect", () => {
	let active: number[] = [];
	for (let i = 0; i < 100; i++) {
		active = active.slice(voicesToStop(active.length));
		active.push(i);
		assert.ok(active.length <= 24);
	}
	assert.equal(MAX_VOICES, 24);
	assert.deepEqual(active, Array.from({ length: 24 }, (_, i) => i + 76));
	assert.equal(voicesToStop(23), 0);
	assert.equal(voicesToStop(24), 1);
});

test("fixed random inputs give reproducible music plans and the required sound and silence ranges", () => {
	for (const sample of [0, 0.33, 0.99999]) {
		const day = musicPlan(false, () => sample);
		const night = musicPlan(true, () => sample);
		assert.deepEqual(day, musicPlan(false, () => sample));
		assert.ok(night.beat > day.beat);
		for (const [plan, root, scale] of [[day, 55, [0, 2, 4, 7, 9]], [night, 48, [0, 3, 5, 7, 10]]] as const) {
			assert.ok(plan.duration >= 60 && plan.duration <= 180);
			assert.ok(plan.silence >= 120 && plan.silence <= 300);
			assert.ok(plan.notes.length > 0);
			assert.equal(plan.notes[0].at, 0);
			assert.ok(plan.notes.every((note, i) => note.at >= (plan.notes[i - 1]?.at ?? 0)
				&& note.at + note.duration < plan.duration
				&& scale.includes((note.midi - root + 12) % 12)));
		}
	}
});

test("vitals compare only the previous living state and emit the appropriate transitions", () => {
	const alive = { health: 14, food: 13, dead: false };
	const dead = { health: 0, food: 13, dead: true };
	assert.deepEqual(playerSounds(alive, { ...alive, food: 19 }), [{ kind: "eat" }]);
	assert.deepEqual(playerSounds(alive, dead), [{ kind: "playerHurt" }, { kind: "death" }]);
	assert.deepEqual(playerSounds(dead, { health: 20, food: 20, dead: false }), []);
});

test("creeper ignition and explosion are distinct from other mob removals", () => {
	assert.equal(creeperIgnited(0, 1), true);
	assert.equal(creeperIgnited(0, 18), false);
	assert.equal(creeperIgnited(1, 2), false);
	assert.deepEqual(mobRemovalSound({ kind: 6, fuse: 30 }, 30), { kind: "explosion" });
	assert.deepEqual(mobRemovalSound({ kind: 2, fuse: 0 }, 500), { kind: "mobDeath", mob: 2 });
	assert.equal(mobRemovalSound({ kind: 6, fuse: 10 }, Infinity), null);
});

test("arrow impacts infer embedding from the preserved vector and hits from the flight segment", () => {
	const arrow: ArrowEntity = { id: 1, position: [0, 0, 0], previous: [-2, 0, 0], velocity: [2, 0, 0] };
	assert.equal(arrowStopped(arrow, { ...arrow, position: [1.5, 0, 0] }), true);
	assert.equal(arrowStopped(arrow, { ...arrow, velocity: [0, 0, 0] }), true);
	assert.equal(arrowStopped(arrow, { ...arrow, velocity: [1.98, -0.05, 0] }), false);
	assert.deepEqual(arrowHitPosition(arrow, [[1, 0.3, 0], [2, 2, 0]]), [1, 0, 0]);
	assert.equal(arrowHitPosition(arrow, [[5, 0, 0]]), null);
});
