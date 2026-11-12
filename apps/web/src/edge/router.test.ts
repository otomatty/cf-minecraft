import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "./router.ts";
import type { RouterDeps, User } from "./router.ts";
import { createDB } from "./db.ts";
import { testDB } from "./d1-shim.test.ts";

const owner: User = { id: "owner", name: "Owner", email: "Owner@example.com", emailVerified: true };
const player: User = {
	id: "player",
	name: "Player",
	email: "PLAYER@example.com",
	emailVerified: true,
};
const other: User = { id: "other", name: "Other", email: "other@example.com", emailVerified: true };

async function setup(t) {
	const f = testDB();
	t.after(f.close);
	for (const u of [owner, player, other]) {
		f.user(u.id, u.email);
	}
	const db = createDB(f.db);
	await db.createWorld("lobby", owner.id, owner.email.toLowerCase());
	await db.putMember("lobby", player.email.toLowerCase(), "player");
	let user: User | null = null;
	const calls: string[] = [];
	const forwarded: Request[] = [];
	const revocations: [string, string][] = [];
	let revokeFailure = false;
	const limits: [string, string][] = [];
	let blocked = "";
	let captcha = true;
	let authCalls = 0;
	const deps: RouterDeps = {
		env: {
			DEBUG: "0",
			ACCESS_TOKEN: "operator-secret",
			WORLD_CREATORS: "  OWNER@EXAMPLE.COM ,",
			BETTER_AUTH_SECRET: "test-only-secret",
			GOOGLE_CLIENT_ID: "test-id",
			GOOGLE_CLIENT_SECRET: "test-secret",
			TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
			TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
		},
		worlds: {
			getByName(name) {
				calls.push(name);
				return {
					async fetch(request) {
						forwarded.push(request);
						return new Response("forwarded");
					},
					async revoke(userId) {
						revocations.push([name, userId]);
						if (revokeFailure) {
							throw new Error("revoke failed");
						}
						return 0;
					},
					async metrics() {
						return { players: 1 };
					},
					async scenario(seed, ticks) {
						return { seed, ticks };
					},
				};
			},
		},
		auth: {
			async getUser() {
				return user;
			},
			async handler() {
				authCalls++;
				return Response.json({ auth: true });
			},
		},
		db,
		async limiter(name, key) {
			limits.push([name, key]);
			return name !== blocked;
		},
		async turnstile() {
			return captcha;
		},
	};
	const request = (path: string, method = "GET", input?: unknown, headers = {}) =>
		handle(
			new Request(`https://game.example${path}`, {
				method,
				headers: { ...(method === "GET" ? {} : { Origin: "https://game.example" }), ...headers },
				body: input === undefined ? undefined : JSON.stringify(input),
			}),
			deps,
		);
	return {
		...f,
		deps,
		db,
		calls,
		forwarded,
		revocations,
		failRevocation() {
			revokeFailure = true;
		},
		limits,
		request,
		login(u: User | null) {
			user = u;
		},
		block(name: string) {
			blocked = name;
		},
		captcha(ok: boolean) {
			captcha = ok;
		},
		authCalls: () => authCalls,
	};
}

test("unauthenticated, unknown and non-member worlds never reach DO", async t => {
	const f = await setup(t);
	for (const path of ["/ws/lobby", "/api/worlds/lobby/metrics"]) {
		assert.equal((await f.request(path)).status, 401);
	}
	f.login(other);
	for (const path of ["/ws/lobby", "/api/worlds/lobby/metrics"]) {
		assert.equal((await f.request(path)).status, 403);
	}
	for (const path of ["/ws/missing", "/api/worlds/missing/metrics"]) {
		assert.equal((await f.request(path)).status, 404);
	}
	assert.deepEqual(f.calls, []);
});

test("membership uses verified lowercase email; forwarded identity overwrites client header", async t => {
	const f = await setup(t);
	f.login(player);
	assert.equal(
		(await f.request("/ws/lobby", "GET", undefined, { "X-MC-User": "spoofed" })).status,
		200,
	);
	assert.equal(f.forwarded[0].headers.get("X-MC-User"), player.id);
	assert.equal((await f.request("/api/worlds/lobby/metrics")).status, 403);
	f.login({ ...player, emailVerified: false });
	assert.equal((await f.request("/ws/lobby")).status, 403);
	f.login(owner);
	assert.equal((await f.request("/api/worlds/lobby/metrics")).status, 200);
	assert.deepEqual(f.calls, ["lobby", "lobby"]);
});

test("operator Bearer bypasses registration; cookie does not; failures consume AUTH_LIMIT", async t => {
	const f = await setup(t);
	for (const path of ["/ws/missing", "/api/worlds/missing/metrics"]) {
		assert.equal(
			(await f.request(path, "GET", undefined, { Cookie: "mc_session=operator-secret" })).status,
			401,
		);
		assert.equal(
			(await f.request(path, "GET", undefined, { Authorization: "Bearer operator-secret" })).status,
			200,
		);
	}
	assert.match(f.forwarded[0].headers.get("X-MC-User"), /^ops:/);
	assert.equal(
		(
			await f.request("/ws/lobby", "GET", undefined, {
				Authorization: "Bearer wrong",
				"CF-Connecting-IP": "192.0.2.1",
			})
		).status,
		401,
	);
	assert.ok(f.limits.some(([name, key]) => name === "AUTH_LIMIT" && key === "192.0.2.1"));
});

test("world creation permission, captcha, duplicate, quota, and creator membership", async t => {
	const f = await setup(t);
	const create = (name = "new") =>
		f.request("/api/worlds", "POST", { name, turnstileToken: "token" });
	assert.equal((await create()).status, 401);
	f.login(other);
	assert.equal((await create()).status, 403);
	f.login(owner);
	f.captcha(false);
	assert.equal((await create()).status, 403);
	f.captcha(true);
	assert.equal((await create("BAD NAME")).status, 400);
	assert.equal((await create()).status, 201);
	assert.deepEqual(await f.db.member("new", "owner@example.com"), { role: "operator" });
	assert.equal((await create()).status, 409);
	for (const name of ["two", "three", "four"]) {
		assert.equal((await create(name)).status, 201);
	}
	assert.equal((await create("six")).status, 429);
});

test("member API restricts operators and protects owner; lists and normalizes invites", async t => {
	const f = await setup(t);
	f.login(player);
	assert.equal((await f.request("/api/worlds/lobby/members")).status, 403);
	f.login(owner);
	assert.equal(
		(await f.request("/api/worlds/lobby/members/OWNER%40example.com", "DELETE")).status,
		400,
	);
	assert.equal(
		(
			await f.request("/api/worlds/lobby/members", "POST", {
				email: "OWNER@example.com",
				role: "player",
			})
		).status,
		400,
	);
	assert.equal(
		(
			await f.request("/api/worlds/lobby/members", "POST", {
				email: "Invited@example.com",
				role: "player",
			})
		).status,
		200,
	);
	assert.deepEqual(await f.db.member("lobby", "invited@example.com"), { role: "player" });
	const list = await (await f.request("/api/worlds/lobby/members")).json();
	assert.equal(list.members.length, 3);
	assert.equal(
		(await f.request("/api/worlds/lobby/members/invited%40example.com", "DELETE")).status,
		200,
	);
	assert.equal(await f.db.member("lobby", "invited@example.com"), null);
});

test("mutations require exact same Origin; websocket rejects foreign origins first", async t => {
	const f = await setup(t);
	f.login(owner);
	assert.equal(
		(
			await f.request(
				"/api/worlds",
				"POST",
				{ name: "new", turnstileToken: "token" },
				{ Origin: "https://evil.example" },
			)
		).status,
		403,
	);
	assert.equal(
		(
			await f.request("/api/worlds/lobby/members/player%40example.com", "DELETE", undefined, {
				Origin: "null",
			})
		).status,
		403,
	);
	const request = new Request("https://game.example/api/worlds", { method: "POST", body: "{}" });
	assert.equal((await handle(request, f.deps)).status, 403);
	f.block("IP_LIMIT");
	assert.equal(
		(await f.request("/ws/lobby", "GET", undefined, { Origin: "https://evil.example" })).status,
		403,
	);
	assert.deepEqual(f.calls, []);
});

test("all three rate limiters reject with 429; get-session skips AUTH_LIMIT", async t => {
	const f = await setup(t);
	f.login(owner);
	f.block("IP_LIMIT");
	assert.equal((await f.request("/ws/lobby")).status, 429);
	assert.equal((await f.request("/api/me")).status, 429);
	f.block("AUTH_LIMIT");
	assert.equal((await f.request("/api/auth/sign-in/social", "POST", {})).status, 429);
	assert.equal((await f.request("/api/auth/get-session")).status, 200);
	assert.equal(
		(await f.request("/ws/lobby", "GET", undefined, { Authorization: "Bearer wrong" })).status,
		429,
	);
	f.block("USER_LIMIT");
	assert.equal(
		(await f.request("/api/worlds", "POST", { name: "new", turnstileToken: "token" })).status,
		429,
	);
	assert.ok(f.limits.some(([name, key]) => name === "USER_LIMIT" && key === owner.id));
});

test("each required secret fails closed including operator requests", async t => {
	const f = await setup(t);
	for (const key of [
		"BETTER_AUTH_SECRET",
		"GOOGLE_CLIENT_ID",
		"GOOGLE_CLIENT_SECRET",
		"TURNSTILE_SECRET_KEY",
		"TURNSTILE_SITE_KEY",
	] as const) {
		const saved = f.deps.env[key];
		delete f.deps.env[key];
		for (const path of [
			"/api/me",
			"/ws/lobby",
			"/api/worlds/lobby/metrics",
			"/api/auth/get-session",
		]) {
			assert.equal(
				(await f.request(path, "GET", undefined, { Authorization: "Bearer operator-secret" }))
					.status,
				503,
			);
		}
		f.deps.env[key] = saved;
	}
	assert.deepEqual(f.calls, []);
});

test("DEBUG stays open without secrets and bypasses limiters", async t => {
	const f = await setup(t);
	f.deps.env = { DEBUG: "1" };
	f.block("IP_LIMIT");
	assert.equal(
		(await f.request("/ws/unregistered", "GET", undefined, { "X-MC-User": "spoofed" })).status,
		200,
	);
	assert.match(f.forwarded[0].headers.get("X-MC-User"), /^dev:/);
	assert.equal((await f.request("/api/worlds/unregistered/metrics")).status, 200);
	assert.deepEqual(await (await f.request("/api/worlds/unregistered")).json(), {
		name: "unregistered",
		role: "operator",
		owner: false,
	});
	assert.deepEqual(f.limits, []);
	assert.equal((await f.request("/api/debug/scenario?seed=-2026&ticks=1")).status, 200);
	assert.equal((await f.request("/api/debug/scenario?ticks=2001")).status, 400);
	assert.equal((await f.request("/api/debug/scenario", "POST", {})).status, 405);
});

test("me, world lists, JSON size, malformed bodies, and response cache headers", async t => {
	const f = await setup(t);
	f.login(owner);
	const me = await f.request("/api/me");
	assert.equal(me.headers.get("Cache-Control"), "no-store");
	assert.equal((await me.json()).canCreateWorlds, true);
	assert.deepEqual(await (await f.request("/api/worlds")).json(), {
		worlds: [{ name: "lobby", role: "operator", owner: true }],
	});
	assert.deepEqual(await (await f.request("/api/worlds/lobby")).json(), {
		name: "lobby",
		role: "operator",
		owner: true,
	});
	for (const text of [
		"{",
		"[]",
		"null",
		JSON.stringify({ name: "new", turnstileToken: "x".repeat(2048) }),
		JSON.stringify({ name: "new" }),
	]) {
		assert.equal(
			(
				await handle(
					new Request("https://game.example/api/worlds", {
						method: "POST",
						headers: { Origin: "https://game.example" },
						body: text,
					}),
					f.deps,
				)
			).status,
			400,
		);
	}
	assert.equal((await f.request("/api/session")).status, 404);
});

test("member deletion revokes every user ID matching the normalized email", async t => {
	const f = await setup(t);
	f.user("player-alias", "player@example.com");
	f.login(owner);
	const response = await f.request("/api/worlds/lobby/members/PLAYER%40example.com", "DELETE");
	assert.equal(response.status, 200);
	assert.equal(await f.db.member("lobby", "player@example.com"), null);
	assert.deepEqual(f.revocations.sort(), [
		["lobby", "player"],
		["lobby", "player-alias"],
	]);
});

test("member deletion still succeeds when revoke rejects", async t => {
	const f = await setup(t);
	f.login(owner);
	f.failRevocation();
	const response = await f.request("/api/worlds/lobby/members/player%40example.com", "DELETE");
	assert.equal(response.status, 200);
	assert.equal(await f.db.member("lobby", "player@example.com"), null);
	assert.deepEqual(f.revocations, [["lobby", player.id]]);
});

test("successful sign-out revokes all memberships and preserves the auth response", async t => {
	const f = await setup(t);
	await f.db.createWorld("other-world", other.id, other.email.toLowerCase());
	await f.db.putMember("other-world", player.email.toLowerCase(), "player");
	f.login(player);
	f.failRevocation();
	f.deps.auth.handler = async () => {
		f.login(null);
		return Response.json(
			{ signedOut: true },
			{
				status: 202,
				headers: { "Set-Cookie": "session=; Max-Age=0" },
			},
		);
	};
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 202);
	assert.equal(response.headers.get("Set-Cookie"), "session=; Max-Age=0");
	assert.deepEqual(await response.json(), { signedOut: true });
	assert.deepEqual(f.revocations, [
		["lobby", player.id],
		["other-world", player.id],
	]);
});

test("failed sign-out does not revoke memberships", async t => {
	const f = await setup(t);
	f.login(player);
	f.deps.auth.handler = async () => Response.json({ error: "failed" }, { status: 400 });
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "failed" });
	assert.deepEqual(f.revocations, []);
	assert.deepEqual(f.calls, []);
});

test("sign-out without a verified user does not revoke memberships", async t => {
	const f = await setup(t);
	for (const user of [null, { ...player, emailVerified: false }]) {
		f.login(user);
		assert.equal((await f.request("/api/auth/sign-out", "POST", {})).status, 200);
	}
	assert.deepEqual(f.revocations, []);
	assert.deepEqual(f.calls, []);
});
