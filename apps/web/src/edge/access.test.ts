// Run with: node --test apps/web/src/edge/access.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { accessDenial, sessionCookie, tokenFromRequest } from "./access.ts";

const secret = "correct-horse";

test("development does not ask for a token", async () => {
	assert.equal(await accessDenial({ DEBUG: "1" }, null), null);
});

test("production without a configured token stays closed", async () => {
	assert.equal(await accessDenial({ DEBUG: "0" }, secret), 503);
});

test("production rejects a missing or wrong token", async () => {
	const env = { DEBUG: "0", ACCESS_TOKEN: secret };
	assert.equal(await accessDenial(env, null), 401);
	assert.equal(await accessDenial(env, ""), 401);
	assert.equal(await accessDenial(env, "nope"), 401);
	assert.equal(await accessDenial(env, secret), null);
});

test("the token is read from a bearer header, otherwise the session cookie", () => {
	const bearer = new Request("https://game.example/ws/lobby", {
		headers: { Authorization: `Bearer ${secret}`, Cookie: "mc_session=other" },
	});
	assert.equal(tokenFromRequest(bearer), secret);
	const cookie = new Request("https://game.example/ws/lobby", {
		headers: { Cookie: `mc_session=${encodeURIComponent(secret)}` },
	});
	assert.equal(tokenFromRequest(cookie), secret);
	assert.equal(tokenFromRequest(new Request("https://game.example/ws/lobby")), null);
});

test("the session cookie is not readable from script", () => {
	const header = sessionCookie(secret, true);
	assert.match(header, /HttpOnly/);
	assert.match(header, /Secure/);
	assert.match(header, /SameSite=Strict/);
	assert.equal(sessionCookie(secret, false).includes("Secure"), false);
});
