import assert from "node:assert/strict";
import { test } from "node:test";
import { lightmap, celestialAngle, parseStartTime, partialDayTicks, skyState } from "./sky.ts";
import { moonSheetOrder } from "./texture-pack.ts";
import { preparePackTextures } from "./renderer.ts";
import { decodedFixturePack, fixtureArtRGB } from "../../test/texture-pack-fixture.mjs";

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

test("pack sky art keeps native dimensions and orders all eight lunar phases", async () => {
	const { sun, moon, clouds } = preparePackTextures([], await decodedFixturePack());
	assert.equal(sun?.length, 32 ** 2 * 4);
	assert.equal(moon?.length, 128 * 64 * 4);
	assert.equal(clouds?.length, 256 ** 2 * 4);
	assert.deepEqual([...sun!.subarray(0, 4)], [0, 0, 0, 0]);
	assert.equal(new Set(moonSheetOrder).size, 8);
	for (const cell of moonSheetOrder) {
		const x = (cell < 4 ? 12 : 19) + cell % 4 * 32;
		const y = 16 + Math.floor(cell / 4) * 32;
		const offset = 4 * (y * 128 + x);
		const expected = cell === 4 ? [0, 0, 0, 0] : [...fixtureArtRGB("environment/moon_phases", false, cell), 255];
		assert.deepEqual([...moon!.subarray(offset, offset + 4)], expected);
	}
});

test("lightmap separates daylight, cave darkness and warm block light", () => {
	const day = lightmap(skyState(6000).skylight);
	const night = lightmap(skyState(18000).skylight);
	const rgb = (map, block, sky) => [...map.slice((sky * 16 + block) * 4, (sky * 16 + block) * 4 + 3)];
	assert.deepEqual(rgb(day, 0, 15), [255,255,255]);
	assert.deepEqual(rgb(night, 0, 0), [10,10,10]);
	assert.deepEqual(rgb(day, 0, 0), rgb(night, 0, 0));
	const lamp = rgb(night, 15, 0);
	assert.ok(lamp[0] === 255 && lamp[1] > 200 && lamp[2] > 160);
	assert.ok(lamp[0] > lamp[1] && lamp[1] > lamp[2]);
	assert.ok(rgb(night,0,15)[0] < rgb(day,0,15)[0]);
	for (let n=1; n<16; n++) assert.ok(rgb(day,n,0)[0] > rgb(day,n-1,0)[0]);
});
