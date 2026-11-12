import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIP, createLimiter } from "./ratelimit.ts";

test("rate binding receives its key and propagates denial; DEBUG bypasses it", async () => {
	const keys: string[] = [];
	const binding = {
		async limit({ key }) {
			keys.push(key);
			return { success: false };
		},
	};
	const env = { DEBUG: "0", IP_LIMIT: binding, AUTH_LIMIT: binding, USER_LIMIT: binding };
	const limiter = createLimiter(env);
	assert.equal(await limiter("USER_LIMIT", "user-id"), false);
	assert.deepEqual(keys, ["user-id"]);
	env.DEBUG = "1";
	assert.equal(await limiter("IP_LIMIT", "192.0.2.1"), true);
	assert.deepEqual(keys, ["user-id"]);
});

test("IP defaults to unknown when CF-Connecting-IP is missing", () => {
	assert.equal(clientIP(new Request("https://game.example")), "unknown");
	assert.equal(
		clientIP(new Request("https://game.example", { headers: { "CF-Connecting-IP": "192.0.2.1" } })),
		"192.0.2.1",
	);
});
