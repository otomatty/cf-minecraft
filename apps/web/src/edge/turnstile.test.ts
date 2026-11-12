import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTurnstile } from "./turnstile.ts";

test("siteverify sends secret, token and client IP", async () => {
	const fetcher = async (url, init) => {
		assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
		assert.equal(init.method, "POST");
		assert.equal(init.body.get("secret"), "1x0000000000000000000000000000000AA");
		assert.equal(init.body.get("response"), "token");
		assert.equal(init.body.get("remoteip"), "192.0.2.1");
		return Response.json({ success: true });
	};
	assert.equal(
		await verifyTurnstile("1x0000000000000000000000000000000AA", "token", "192.0.2.1", fetcher),
		true,
	);
});

test("siteverify fails closed for errors, malformed JSON and false results", async () => {
	for (const fetcher of [
		async () => {
			throw new Error("offline");
		},
		async () => new Response("bad"),
		async () => Response.json({ success: false }),
		async () => Response.json({ success: "true" }),
		async () => new Response("unavailable", { status: 503 }),
	]) {
		assert.equal(await verifyTurnstile("secret", "token", null, fetcher), false);
	}
	assert.equal(
		await verifyTurnstile("secret", "", null, async () => {
			throw new Error("must not fetch");
		}),
		false,
	);
});
