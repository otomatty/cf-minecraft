import assert from "node:assert/strict";
import { test } from "node:test";
import { gameRedirect, safeNext, thumbPosition } from "./title-route.ts";

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

test("world thumbnails are deterministic and use a known crop", () => {
	const positions = ["10% 20%", "30% 60%", "50% 35%", "70% 70%", "90% 25%", "60% 90%"];
	for (const name of ["", "lobby", "world-1", "another_world", "日本語", "a".repeat(32)]) {
		assert.equal(thumbPosition(name), thumbPosition(name));
		assert.ok(positions.includes(thumbPosition(name)));
	}
});
