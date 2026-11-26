import test from "node:test";
import assert from "node:assert/strict";
import { advanceDig, digSelection, updateDigSelection, invalidateDigSelection, newDigState, observeDigBlockUpdate, digVertices } from "./dig.ts";
import { TEX_SIZE } from "./textures.ts";
import { crackPaths } from "./texture-pack.ts";
import { preparePackTextures } from "./renderer.ts";
import { decodedFixturePack } from "../../test/texture-pack-fixture.mjs";
const target = { x: 1, y: 2, z: 3, state: 1, ticks: 12 };

test("press, integer tick stages, completion waits for server and release aborts", () => {
	let result = advanceDig(newDigState(), true, target, null, 100);
	assert.deepEqual(result.commands, [{ type: "start", target }]);
	for (const [now, stage] of [[149,0],[150,0],[200,1],[650,9],[700,9],[2000,9]]) {
		result = advanceDig(result.state, true, target, 1, now);
		assert.equal(result.state.active?.stage, stage);
		assert.deepEqual(result.commands, []);
	}
	result = advanceDig(result.state, false, target, 1, 2001);
	assert.equal(result.state.active, null);
	assert.deepEqual(result.commands, [{ type: "abort" }]);
});

test("aim switches, lost targets, changed blocks, zero duration and cooldown", () => {
	let r = advanceDig(newDigState(), true, target, null, 0);
	const next = { ...target, x: 2, ticks: 0 };
	r = advanceDig(r.state, true, next, 1, 100);
	assert.deepEqual(r.commands, [{ type: "abort" }, { type: "start", target: next }]);
	assert.equal(r.state.active?.stage, 9);
	r = advanceDig(r.state, true, target, 0, 150);
	assert.equal(r.state.active, null);
	assert.equal(r.state.readyAt, 400);
	r = advanceDig(r.state, true, target, null, 399);
	assert.deepEqual(r.commands, []);
	r = advanceDig(r.state, true, target, null, 400);
	assert.deepEqual(r.commands, [{ type: "start", target }]);
	r = advanceDig(r.state, true, null, 1, 410);
	assert.deepEqual(r.commands, [{ type: "abort" }]);
	assert.equal(r.state.active, null);
	r = advanceDig(r.state, true, target, null, 420);
	const changed = { ...target, state: 3 };
	r = advanceDig(r.state, true, changed, 3, 430);
	assert.deepEqual(r.commands, [{ type: "abort" }, { type: "start", target: changed }]);
});

test("crack layers preserve ten ordered masks from the fixture pack", async () => {
	const pack = await decodedFixturePack();
	const { cracks } = preparePackTextures([], pack);
	assert.equal(cracks.length, 10);
	let previous = new Uint8Array(TEX_SIZE * TEX_SIZE * 4), count = 0;
	for (let stage = 0; stage < 10; stage++) {
		const pixels = cracks[stage]!;
		assert.equal(pixels, pack.art.get(crackPaths[stage]));
		assert.equal(pixels.length, TEX_SIZE * TEX_SIZE * 4);
		let current = 0;
		for (let i = 3; i < pixels.length; i += 4) {
			if (pixels[i]) current++;
			if (previous[i]) assert.ok(pixels[i]);
		}
		assert.ok(current > count);
		previous = pixels; count = current;
	}
	assert.equal(cracks[10], undefined);
	assert.equal(cracks[-1], undefined);
});

test("overlay cube uses camera-relative vertices and the requested stage layer", () => {
	const data = digVertices([{ x: 1000000, y: 2, z: 3, stage: 7, bounds: { min: [0,0,0], max: [1,1,1] } }], [1000000,2,3], 27);
	assert.equal(data.length, 36 * 9);
	assert.ok(Math.abs(data[0] + .002) < 1e-8);
	assert.equal(data[6], 34);
	assert.equal(digVertices([], [0,0,0], 0).length, 0);
});

test("updates between frames invalidate restored targets and remember a break cooldown", () => {
	let r = advanceDig(newDigState(), true, target, null, 0);
	r = advanceDig(r.state, true, target, target.state, 1000);
	assert.equal(r.state.active?.stage, 9);
	assert.equal(observeDigBlockUpdate(r.state, 99, target.y, target.z, 0, 1000), r.state);
	let state = observeDigBlockUpdate(r.state, target.x, target.y, target.z, 0, 1000);
	state = observeDigBlockUpdate(state, target.x, target.y, target.z, target.state, 1001);
	r = advanceDig(state, true, target, target.state, 1010);
	assert.deepEqual(r.commands, [{ type: "abort" }]);
	assert.equal(r.state.active, null);
	assert.equal(r.state.invalidated, false);
	r = advanceDig(r.state, true, target, target.state, 1249);
	assert.deepEqual(r.commands, []);
	r = advanceDig(r.state, true, target, target.state, 1250);
	assert.deepEqual(r.commands, [{ type: "start", target }]);
	assert.equal(r.state.active?.stage, 0);
	assert.equal(r.state.active?.started, 1250);
});

test("restored non-air updates restart held mining and release keeps it stopped", () => {
	for (const held of [false, true]) {
		const initial = advanceDig(newDigState(), true, target, null, 0).state;
		let state = observeDigBlockUpdate(initial, target.x, target.y, target.z, 2, 100);
		state = observeDigBlockUpdate(state, target.x, target.y, target.z, target.state, 101);
		const r = advanceDig(state, held, target, target.state, 110);
		assert.deepEqual(r.commands, held ? [{ type: "abort" }, { type: "start", target }] : [{ type: "abort" }]);
		assert.equal(r.state.active?.started ?? null, held ? 110 : null);
	}
});

test("lower slab cracks stay within the half-height selection bounds plus margin", () => {
	const data = digVertices([{ x: 0, y: 0, z: 0, stage: 5, bounds: { min: [0,0,0], max: [1,.5,1] } }], [0,0,0], 27);
	const heights = [...data].filter((_, i) => i % 9 === 1);
	assert.equal(heights.length, 36);
	assert.ok(Math.min(...heights) >= -.002001);
	assert.ok(Math.max(...heights) <= .502001);
	assert.ok(Math.max(...heights) >= .5);
});


test("switching held slot or contents aborts and restarts while held", () => {
	const first = { ...target, selection: digSelection(0, { item: 31 }), ticks: 35 };
	const initial = advanceDig(newDigState(), true, first, null, 0).state;
	for (const selection of [digSelection(1, { item: 31 }), digSelection(0, { item: 32 }), digSelection(0, null)]) {
		const nextTarget = { ...target, selection, ticks: 70 };
		const result = advanceDig(initial, true, nextTarget, target.state, 500);
		assert.deepEqual(result.commands.map(c => c.type), ["abort", "start"]);
		assert.equal(result.state.active?.started, 500);
		assert.equal(result.state.active?.ticks, 70);
	}
	// Switching away and back before a frame must still restart.
	const invalidated = invalidateDigSelection(initial);
	const result = advanceDig(invalidated, true, first, target.state, 600);
	assert.deepEqual(result.commands.map(c => c.type), ["abort", "start"]);
	const released = advanceDig(invalidated, false, first, target.state, 600);
	assert.deepEqual(released.commands, [{ type: "abort" }]);
	assert.equal(released.state.active, null);
});


test("count-only Inventory updates preserve local mining progress", () => {
	let stack = { item: 3, count: 2 };
	const heldInventory = digSelection(0, stack);
	const initialTarget = { ...target, selection: heldInventory };
	let state = advanceDig(newDigState(), true, initialTarget, null, 100).state;
	for (const count of [3, 4, 3, 1]) {
		stack = { ...stack, count };
		const held = digSelection(0, stack);
		assert.equal(held, heldInventory);
		if (held !== heldInventory) state = invalidateDigSelection(state);
		const nextTarget = { ...target, selection: digSelection(0, stack) };
		const result = advanceDig(state, true, nextTarget, target.state, 400);
		assert.deepEqual(result.commands, []);
		assert.equal(result.state.active?.started, 100);
		assert.equal(result.state.active?.stage, 5);
		state = result.state;
	}
	assert.notEqual(digSelection(0, { item: 4 }), heldInventory);
	assert.notEqual(digSelection(1, stack), heldInventory);
	assert.notEqual(digSelection(0, null), heldInventory);
	assert.equal(digSelection(0, undefined), digSelection(0, null));
});


test("selection acknowledgement preserves a dig started after a local slot switch", () => {
	const inventory = [{ item: 31, count: 1 }, { item: 34, count: 1 }];
	const oldTarget = { ...target, selection: digSelection(0, inventory[0]) };
	const oldDig = advanceDig(newDigState(), true, oldTarget, null, 0).state;
	const local = updateDigSelection(oldDig, oldTarget.selection, 1, inventory[1]);
	assert.equal(local.state.invalidated, true);
	const nextTarget = { ...target, selection: local.selection };
	const started = advanceDig(local.state, true, nextTarget, target.state, 100);
	assert.deepEqual(started.commands.map(c => c.type), ["abort", "start"]);

	// A confirmation of the optimistic selection uses the already updated baseline.
	const confirmed = updateDigSelection(started.state, local.selection, 1, inventory[1]);
	assert.equal(confirmed.state.invalidated, false);
	const continued = advanceDig(confirmed.state, true, nextTarget, target.state, 400);
	assert.deepEqual(continued.commands, []);
	assert.equal(continued.state.active?.started, 100);
	assert.equal(continued.state.active?.stage, 5);

	// An actual item change in that same selected slot still cancels the dig.
	const changed = updateDigSelection(continued.state, confirmed.selection, 1, { item: 35 });
	assert.equal(changed.state.invalidated, true);
	const restarted = advanceDig(changed.state, true, { ...target, selection: changed.selection }, target.state, 500);
	assert.deepEqual(restarted.commands.map(c => c.type), ["abort", "start"]);
	assert.equal(restarted.state.active?.started, 500);
});

test("switching away and back before a frame keeps the dig invalidated", () => {
	const held = { item: 31 };
	const firstTarget = { ...target, selection: digSelection(0, held) };
	const state = advanceDig(newDigState(), true, firstTarget, null, 0).state;
	const away = updateDigSelection(state, firstTarget.selection, 1, held);
	const back = updateDigSelection(away.state, away.selection, 0, held);
	assert.equal(back.selection, firstTarget.selection);
	assert.equal(back.state.invalidated, true);
	const restarted = advanceDig(back.state, true, firstTarget, target.state, 100);
	assert.deepEqual(restarted.commands.map(c => c.type), ["abort", "start"]);
});
