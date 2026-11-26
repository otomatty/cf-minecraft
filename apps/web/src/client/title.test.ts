import assert from "node:assert/strict";
import { test } from "node:test";
import { titleCameraHeight, titleChunks, titleYaw } from "./title-landscape.ts";
import { gameRedirect, hasPlaySession, safeNext, thumbColor, titleScreen } from "./title-route.ts";

test("title stays for no query or a login return URL", () => {
	assert.equal(gameRedirect(""), null);
	assert.equal(gameRedirect("?next=%2Fplay.html"), null);
});

test("legacy game queries redirect to play with the original query", () => {
	for (const search of ["?world=main", "?server=ws&world=lobby", "?autopilot=1"]) {
		assert.equal(gameRedirect(search), "/play.html" + search);
	}
});

test("every game parameter redirects even with an empty value", () => {
	for (const key of ["server", "world", "view", "gen", "seed", "time", "autopilot"]) {
		const search = `?next=%2Fplay.html&${key}=`;
		assert.equal(gameRedirect(search), "/play.html" + search);
	}
	assert.equal(gameRedirect("?worldName=main"), null);
});

test("safeNext accepts local return paths", () => {
	for (const path of ["/", "/play.html?server=ws&world=lobby", "/play.html#pause"]) {
		assert.equal(safeNext(path), path);
	}
});

test("safeNext rejects external and normalized return paths", () => {
	for (const path of [null, "", "play.html", "https://example.com/", "//example.com", "/\\example.com", "/a\nb", "/a\tb", "/a b", "/a\u0000b", "/a\u007fb", "/a\u00a0b"]) {
		assert.equal(safeNext(path), null);
	}
});

test("world names choose deterministic colors from the palette", () => {
	assert.deepEqual(["", "a", "b", "c", "d", "e"].map(thumbColor),
		["#829fba", "#769262", "#937d67", "#557e91", "#889184", "#a49b7d"]);
	assert.equal(thumbColor("日本語"), "#a49b7d");
});

test("title camera stays eight blocks above the highest non-air cell", () => {
	assert.equal(titleCameraHeight(-64, 319, y => y === 76 ? 12 : Number(y <= 70)), 84);
	assert.equal(titleCameraHeight(-64, 319, y => y === 319 ? 1 : 0), 327);
	assert.equal(titleCameraHeight(-64, 319, () => -1), -56);
});

test("title yaw rotates at a constant speed and respects reduced motion", () => {
	assert.equal(titleYaw(0, false), 105);
	assert.equal(titleYaw(15_000, false), 135);
	assert.equal(titleYaw(45_000, false), 195);
	assert.equal(titleYaw(180_000, false), 105);
	assert.equal(titleYaw(225_000, false), 195);
	assert.equal(titleYaw(225_000, true), 105);
});

test("title chunks are unique, inside the radius, and generated nearest first", () => {
	assert.deepEqual(titleChunks(-2, 3, 1), [[-2, 3], [-2, 2], [-3, 3], [-1, 3], [-2, 4]]);
	const chunks = titleChunks(-2, 3, 6);
	const distances = chunks.map(([x, z]) => (x + 2) ** 2 + (z - 3) ** 2);
	assert.equal(new Set(chunks.map(chunk => chunk.join(","))).size, 113);
	assert.equal(distances.at(-1), 36);
	assert.deepEqual(distances, distances.toSorted((a, b) => a - b));
});

test("title requires a session, then an installed pack", () => {
	for (const me of [{ open: false, user: null }, {}]) {
		assert.equal(titleScreen(me, false), "login");
		assert.equal(titleScreen(me, true), "login");
	}
	for (const me of [{ open: true, user: null }, { open: false, user: { id: "player" } }]) {
		assert.equal(titleScreen(me, false), "textures");
		assert.equal(titleScreen(me, true), "menu");
	}
});

test("play admission requires a user or the development override", () => {
	assert.equal(hasPlaySession({ open: false, user: null }), false);
	assert.equal(hasPlaySession({}), false);
	assert.equal(hasPlaySession({ open: true, user: null }), true);
	assert.equal(hasPlaySession({ open: false, user: { id: "player" } }), true);
});
