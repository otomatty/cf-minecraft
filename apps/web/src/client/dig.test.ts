import test from "node:test";
import assert from "node:assert/strict";
import { advanceDig, newDigState, observeDigBlockUpdate, digVertices } from "./dig.ts";
import { paintCracks, TEX_SIZE } from "./textures.ts";
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

test("cracks have ten deterministic, strictly growing masks", () => {
	let previous = new Uint8Array(TEX_SIZE * TEX_SIZE * 4), count = 0;
	for (let stage = 0; stage < 10; stage++) {
		const pixels = paintCracks(stage);
		assert.deepEqual(pixels, paintCracks(stage));
		assert.equal(pixels.length, TEX_SIZE * TEX_SIZE * 4);
		let current = 0;
		for (let i = 3; i < pixels.length; i += 4) {
			if (pixels[i]) current++;
			if (previous[i]) assert.ok(pixels[i]);
		}
		assert.ok(current > count);
		previous = pixels; count = current;
	}
	assert.throws(() => paintCracks(10), RangeError);
	assert.throws(() => paintCracks(-1), RangeError);
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
