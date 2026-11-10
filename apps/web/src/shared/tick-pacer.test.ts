// Run with: node --test apps/web/src/shared/tick-pacer.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize, TickPacer } from "./tick-pacer.ts";

test("on-time callbacks run exactly one tick each", () => {
	const pacer = new TickPacer(1000);
	for (let i = 1; i <= 100; i++) assert.equal(pacer.due(1000 + i * 50), 1);
	assert.equal(pacer.ticksRun, 100);
	assert.equal(pacer.skipped, 0);
	assert.equal(pacer.measuredTps, 20);
});

test("an early callback runs nothing and the next one catches up", () => {
	const pacer = new TickPacer(0);
	assert.equal(pacer.due(20), 0);
	assert.equal(pacer.due(49), 0);
	assert.equal(pacer.due(50), 1);
	assert.equal(pacer.due(149), 1);
	assert.equal(pacer.due(150), 1);
});

test("a late callback is followed by catch-up ticks", () => {
	const pacer = new TickPacer(0);
	assert.equal(pacer.due(50), 1);
	assert.equal(pacer.due(210), 3);
	assert.equal(pacer.due(250), 1);
	assert.equal(pacer.ticksRun, 5);
	assert.equal(pacer.skipped, 0);
});

test("a long stall is capped and the excess is dropped, not replayed", () => {
	const pacer = new TickPacer(0);
	assert.equal(pacer.due(5000), 10);
	assert.equal(pacer.skipped, 90);
	// Back to normal pace straight away.
	assert.equal(pacer.due(5050), 1);
	assert.equal(pacer.due(5100), 1);
});

test("a slow, jittery timer still averages 20 ticks per second", () => {
	const pacer = new TickPacer(0);
	let now = 0;
	let ticks = 0;
	for (let i = 0; i < 2000; i++) {
		now += 51 + (i % 7); // 51..57 ms between callbacks
		ticks += pacer.due(now);
	}
	assert.equal(ticks, Math.floor(now / 50));
	assert.equal(pacer.skipped, 0);
	assert.ok(Math.abs(pacer.measuredTps - 20) < 0.05, `measured ${pacer.measuredTps}`);
});

test("only the most recent samples are kept", () => {
	const pacer = new TickPacer(0, 50, 10, 16);
	for (let i = 1; i <= 100; i++) pacer.due(i * 50);
	assert.equal(pacer.gaps.length, 16);
	assert.equal(pacer.counts.length, 16);
});

test("summaries", () => {
	assert.deepEqual(summarize([]), { samples: 0, meanMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
	const s = summarize([50, 50, 50, 70]);
	assert.equal(s.samples, 4);
	assert.equal(s.meanMs, 55);
	assert.equal(s.p50Ms, 50);
	assert.equal(s.maxMs, 70);
});
