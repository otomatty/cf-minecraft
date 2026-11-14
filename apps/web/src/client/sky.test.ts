import assert from "node:assert/strict";
import { test } from "node:test";
import { celestialAngle, parseStartTime, partialDayTicks, skyState } from "./sky.ts";
import { paintSkyTexture } from "./textures.ts";

test("celestial angle follows the published cosine correction and repeats daily", () => {
	assert.equal(celestialAngle(6000), 0);
	assert.equal(celestialAngle(18000), 0.5);
	const f = 0.75;
	assert.equal(celestialAngle(0), f + (1 - (Math.cos(f * Math.PI) + 1) / 2 - f) / 3);
	for (const tick of [-24000, 0, 1234.5, 6000, 18000, 23999.75]) {
		assert.ok(Math.abs(celestialAngle(tick) - celestialAngle(tick + 24000)) < 1e-12);
	}
	// Crossing the angle wrap must keep the actual position and lighting continuous.
	const before = skyState(5999.999);
	const after = skyState(6000.001);
	assert.ok(Math.abs(before.sunHeight - after.sunHeight) < 1e-8);
});

test("noon is bright, midnight has stars and a nonzero terrain brightness floor", () => {
	const day = skyState(6000);
	const night = skyState(18000);
	assert.equal(day.skyBrightness, 1);
	assert.equal(night.skyBrightness, 0);
	assert.equal(day.starBrightness, 0);
	assert.equal(night.starBrightness, 0.5);
	assert.equal(day.skylight, 1);
	assert.equal(night.skylight, 0.18);
	assert.ok(day.fogColor.every((c, i) => c > night.fogColor[i]));
	assert.equal(day.sunsetStrength, 0);
	assert.ok(skyState(0).sunsetStrength > 0);
	assert.ok(skyState(12000).sunsetStrength > 0);
});

test("all eight moon phases repeat independently of the daily sun angle", () => {
	for (let day = 0; day < 24; day++) {
		assert.equal(skyState(day * 24000 + 18000).moonPhase, day % 8);
	}
	assert.equal(skyState(24000 - 0.01).moonPhase, 0);
	assert.equal(skyState(24000).moonPhase, 1);
});

test("sky values stay finite and bounded across the full cycle and view distances", () => {
	for (const view of [2, 8, 12]) {
		for (let tick = 0; tick < 24000; tick += 37) {
			const s = skyState(tick, view);
			for (const n of [...s.skyColor, ...s.fogColor, ...s.sunsetColor, s.skyBrightness, s.starBrightness, s.skylight, s.sunsetStrength]) {
				assert.ok(Number.isFinite(n) && n >= 0 && n <= 1, `${tick}: ${n}`);
			}
		}
	}
});

test("time interpolation advances at 20 TPS, including fractional ticks, and caps stale packets", () => {
	assert.equal(partialDayTicks(1025, 1000, true), 0.5);
	assert.equal(partialDayTicks(1750, 1000, true), 15);
	assert.equal(partialDayTicks(9000, 1000, true), 20);
	assert.equal(partialDayTicks(999, 1000, true), 0);
	assert.equal(partialDayTicks(1750, 1000, false), 0);
});

test("URL start times reject malformed, negative, fractional and unsafe integers", () => {
	for (const value of [null, "", "-1", "1.5", "NaN", "Infinity", "1e4", "9007199254740992"]) assert.equal(parseStartTime(value), null);
	assert.equal(parseStartTime("0"), 0);
	assert.equal(parseStartTime("18000"), 18000);
});

test("original sky art is deterministic and all lunar phases have distinct pixels", () => {
	const phases = new Set<string>();
	for (let layer = 0; layer < 10; layer++) {
		const art = paintSkyTexture(layer);
		assert.deepEqual(art, paintSkyTexture(layer));
		if (layer >= 1 && layer <= 8) phases.add(Buffer.from(art).toString("base64"));
	}
	assert.equal(phases.size, 8);
});
