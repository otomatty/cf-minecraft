import assert from "node:assert/strict";
import { test } from "node:test";
import { gameRedirect, hasPlaySession, safeNext, thumbPosition, titleScreen } from "./title-route.ts";

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
