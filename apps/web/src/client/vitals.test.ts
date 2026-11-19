import assert from "node:assert/strict";
import { test } from "node:test";
import { bubbleCount, deathCauses, foodStates, heartStates } from "./vitals.ts";

test("health fills ten hearts from left to right in half-heart steps", () => {
	assert.deepEqual(heartStates(20), Array(10).fill("full"));
	assert.deepEqual(heartStates(13), [...Array(6).fill("full"), "half", "empty", "empty", "empty"]);
	assert.deepEqual(heartStates(2), ["full", ...Array(9).fill("empty")]);
	assert.deepEqual(heartStates(1), ["half", ...Array(9).fill("empty")]);
	assert.deepEqual(heartStates(0), Array(10).fill("empty"));
});

test("food fills ten icons from the right in half-icon steps", () => {
	assert.deepEqual(foodStates(20), Array(10).fill("full"));
	assert.deepEqual(foodStates(15), [...Array(7).fill("full"), "half", "empty", "empty"]);
	assert.deepEqual(foodStates(2), ["full", ...Array(9).fill("empty")]);
	assert.deepEqual(foodStates(1), ["half", ...Array(9).fill("empty")]);
	assert.deepEqual(foodStates(0), Array(10).fill("empty"));
});

test("air uses one bubble per 30 units, rounded up", () => {
	for (const [air, count] of [[0, 0], [1, 1], [29, 1], [30, 1], [31, 2], [270, 9], [299, 10], [300, 10]]) {
		assert.equal(bubbleCount(air), count, `air: ${air}`);
	}
});

test("lava death uses the cause 5 message", () => {
	assert.equal(deathCauses[5], "溶岩で焼けた");
});

test("zombie death uses the cause 6 message", () => {
	assert.equal(deathCauses[6], "ゾンビに倒された");
});
