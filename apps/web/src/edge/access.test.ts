import assert from "node:assert/strict";
import { test } from "node:test";
import { isOperator, tokenFromRequest } from "./access.ts";

const secret = "correct-horse";
const request = (headers = {}) => new Request("https://game.example/ws/lobby", { headers });

test("an unset operator token never grants access", async () => {
	assert.equal(await isOperator(request({ Authorization: `Bearer ${secret}` })), false);
	assert.equal(await isOperator(request(), ""), false);
});

test("only a matching Bearer credential grants operator access", async () => {
	for (const headers of [
		{},
		{ Authorization: "Bearer " },
		{ Authorization: "Bearer nope" },
		{ Authorization: `Basic ${secret}` },
		{ Cookie: `mc_session=${secret}` },
	]) {
		assert.equal(await isOperator(request(headers), secret), false);
	}
	assert.equal(await isOperator(request({ Authorization: `Bearer ${secret}` }), secret), true);
});

test("cookies are never used as an operator credential", () => {
	assert.equal(tokenFromRequest(request({ Cookie: `mc_session=${secret}` })), null);
	assert.equal(
		tokenFromRequest(request({ Authorization: `Bearer ${secret}`, Cookie: "mc_session=other" })),
		secret,
	);
	assert.equal(
		tokenFromRequest(request({ Authorization: "Basic invalid", Cookie: `mc_session=${secret}` })),
		null,
	);
});
