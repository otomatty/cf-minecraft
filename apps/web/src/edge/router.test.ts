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
	const disconnections: [string, number, string][] = [];
	const evictions: string[] = [];
	let revokeFailures = 0;
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
						if (revokeFailures > 0) {
							revokeFailures--;
							throw new Error("revoke failed");
						}
						return 0;
					},
					async disconnectAll(code, reason) {
						disconnections.push([name, code, reason]);
						return 2;
					},
					async evict() {
						evictions.push(name);
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
			async getSession() {
				return user ? { user, session: { id: `session-${user.id}` } } : null;
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
		disconnections,
		evictions,
		failRevocation(count = Infinity) {
			revokeFailures = count;
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

test("member deletion returns 502 after both revoke attempts fail", async t => {
	const f = await setup(t);
	f.login(owner);
	f.failRevocation(2);
	const response = await f.request("/api/worlds/lobby/members/player%40example.com", "DELETE");
	assert.equal(response.status, 502);
	assert.deepEqual(await response.json(), { error: "revoke failed" });
	assert.equal(await f.db.member("lobby", "player@example.com"), null);
	assert.deepEqual(f.revocations, [
		["lobby", player.id],
		["lobby", player.id],
	]);
	assert.equal(
		(await f.request("/api/worlds/lobby/members/player%40example.com", "DELETE")).status,
		200,
	);
	assert.equal(f.revocations.length, 3);
});

test("successful sign-out revokes all memberships and preserves the auth response", async t => {
	const errors = t.mock.method(console, "error", () => {});
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
		["lobby", player.id],
		["other-world", player.id],
	]);
	assert.deepEqual(
		errors.mock.calls.map(call => call.arguments),
		[
			["revoke failed", "lobby", player.id],
			["revoke failed", "other-world", player.id],
		],
	);
});

test("sign-out preserves the auth response when membership lookup rejects", async t => {
	const errors = t.mock.method(console, "error", () => {});
	const f = await setup(t);
	f.login(player);
	const cause = new Error("membership lookup failed");
	f.deps.db.worlds = async () => {
		throw cause;
	};
	f.deps.auth.handler = async () =>
		Response.json(
			{ signedOut: true },
			{
				status: 202,
				headers: {
					"Set-Cookie": "session=; Max-Age=0",
					"X-Auth-Result": "signed-out",
				},
			},
		);
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 202);
	assert.equal(response.headers.get("Set-Cookie"), "session=; Max-Age=0");
	assert.equal(response.headers.get("X-Auth-Result"), "signed-out");
	assert.deepEqual(await response.json(), { signedOut: true });
	assert.deepEqual(
		errors.mock.calls.map(call => call.arguments),
		[["sign-out revoke failed", player.id, cause]],
	);
	assert.deepEqual(f.revocations, []);
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

test("member deletion retries a single revoke failure and returns 200", async t => {
	const f = await setup(t);
	f.login(owner);
	f.failRevocation(1);
	const response = await f.request("/api/worlds/lobby/members/player%40example.com", "DELETE");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {});
	assert.deepEqual(f.revocations, [
		["lobby", player.id],
		["lobby", player.id],
	]);
});

test("Worker timestamps authorization before the membership query and removes spoofed timestamps", async t => {
	const f = await setup(t);
	f.login(player);
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const member = f.deps.db.member;
	f.deps.db.member = async (name, email) => {
		now = 105_000;
		return member(name, email);
	};
	assert.equal(
		(
			await f.request("/ws/lobby", "GET", undefined, {
				"X-MC-Authorized-At": "9999999999999",
			})
		).status,
		200,
	);
	assert.equal(f.forwarded[0].headers.get("X-MC-Authorized-At"), "100000");
});

test("Worker supplies authorization timestamps for operator and development connections", async t => {
	const f = await setup(t);
	t.mock.method(Date, "now", () => 100_000);
	assert.equal(
		(
			await f.request("/ws/lobby", "GET", undefined, {
				Authorization: "Bearer operator-secret",
				"X-MC-Authorized-At": "spoofed",
			})
		).status,
		200,
	);
	f.deps.env = { DEBUG: "1" };
	assert.equal(
		(
			await f.request("/ws/lobby", "GET", undefined, {
				"X-MC-Authorized-At": "spoofed",
			})
		).status,
		200,
	);
	assert.equal(f.forwarded.length, 2);
	for (const request of f.forwarded) {
		assert.equal(request.headers.get("X-MC-Authorized-At"), "100000");
	}
});

test("debug disconnect is hidden in production and bypasses limits in development", async t => {
	const f = await setup(t);
	const disconnect = () => handle(new Request("https://game.example/api/debug/disconnect?world=lobby", { method: "POST" }), f.deps);
	assert.equal((await disconnect()).status, 404);
	assert.deepEqual(f.calls, []);
	f.deps.env = { DEBUG: "1" };
	f.block("IP_LIMIT");
	assert.equal((await f.request("/api/debug/disconnect?world=lobby")).status, 405);
	assert.equal((await f.request("/api/debug/disconnect?world=BAD", "POST")).status, 400);
	const response = await disconnect();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { disconnected: 2 });
	assert.deepEqual(f.disconnections, [["lobby", 1012, "debug disconnect"]]);
	assert.deepEqual(f.limits, []);
});

test("debug disconnect rejects a different Origin without disconnecting players", async t => {
	const f = await setup(t);
	f.deps.env = { DEBUG: "1" };
	const response = await f.request("/api/debug/disconnect?world=lobby", "POST", undefined, { Origin: "https://other.example" });
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "forbidden origin" });
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.disconnections, []);
});

for (const origin of ["https://game.example", null]) {
	test(`debug disconnect accepts ${origin === null ? "no Origin" : "the same Origin"}`, async t => {
		const f = await setup(t);
		f.deps.env = { DEBUG: "1" };
		const response = await handle(new Request("https://game.example/api/debug/disconnect?world=lobby", {
			method: "POST",
			headers: origin === null ? {} : { Origin: origin },
		}), f.deps);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { disconnected: 2 });
		assert.deepEqual(f.disconnections, [["lobby", 1012, "debug disconnect"]]);
	});
}

test("debug evict is hidden in production and bypasses limits in development", async t => {
	const f = await setup(t);
	const evict = () => handle(new Request("https://game.example/api/debug/evict?world=lobby", { method: "POST" }), f.deps);
	assert.equal((await evict()).status, 404);
	assert.deepEqual(f.calls, []);
	f.deps.env = { DEBUG: "1" };
	f.block("IP_LIMIT");
	assert.equal((await f.request("/api/debug/evict?world=lobby")).status, 405);
	for (const world of ["", "BAD", "a".repeat(33), "bad/name"]) {
		assert.equal((await f.request(`/api/debug/evict?world=${encodeURIComponent(world)}`, "POST")).status, 400);
	}
	assert.deepEqual(f.evictions, []);
	const response = await evict();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { evicted: true });
	assert.deepEqual(f.evictions, ["lobby"]);
	assert.deepEqual(f.limits, []);
});

test("debug evict rejects a different Origin without evicting the world", async t => {
	const f = await setup(t);
	f.deps.env = { DEBUG: "1" };
	const response = await f.request("/api/debug/evict?world=lobby", "POST", undefined, { Origin: "https://other.example" });
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "forbidden origin" });
	assert.deepEqual(f.calls, []);
	assert.deepEqual(f.evictions, []);
});

for (const origin of ["https://game.example", null]) {
	test(`debug evict accepts ${origin === null ? "no Origin" : "the same Origin"}`, async t => {
		const f = await setup(t);
		f.deps.env = { DEBUG: "1" };
		const response = await handle(new Request("https://game.example/api/debug/evict?world=lobby", {
			method: "POST",
			headers: origin === null ? {} : { Origin: origin },
		}), f.deps);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { evicted: true });
		assert.deepEqual(f.evictions, ["lobby"]);
	});
}

test("Worker replaces spoofed session IDs with the Better Auth session ID", async t => {
	const f = await setup(t);
	f.login(player);
	await f.request("/ws/lobby", "GET", undefined, { "X-MC-Session": "spoofed-token" });
	assert.equal(f.forwarded[0].headers.get("X-MC-Session"), "session-player");
});

test("Worker strips session IDs from operator and unauthenticated development connections", async t => {
	const f = await setup(t);
	f.login(player);
	await f.request("/ws/lobby", "GET", undefined, {
		Authorization: "Bearer operator-secret", "X-MC-Session": "spoofed",
	});
	f.login(null);
	f.deps.env = { DEBUG: "1" };
	await f.request("/ws/lobby", "GET", undefined, { "X-MC-Session": "spoofed" });
	for (const request of f.forwarded) assert.equal(request.headers.get("X-MC-Session"), null);
	assert.equal(f.forwarded.length, 2);
});

function signOutSession(f) {
	f.sqlite.prepare(
		"INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)",
	).run("session-player", new Date(Date.now() + 86_400_000).toISOString(), "session-token", player.id);
	f.login(player);
	return () => Response.json({ signedOut: true }, {
		headers: { "Set-Cookie": "session=; Max-Age=0" },
	});
}

for (const verified of [true, false]) {
	test(`sign-out with a remaining session returns 503 without clearing cookies (verified=${verified})`, async t => {
		const errors = t.mock.method(console, "error", () => {});
		const f = await setup(t);
		f.deps.auth.handler = signOutSession(f);
		f.login({ ...player, emailVerified: verified });
		const response = await f.request("/api/auth/sign-out", "POST", {});
		assert.equal(response.status, 503);
		assert.equal(response.headers.has("Set-Cookie"), false);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await response.json(), { error: "sign-out incomplete" });
		assert.equal(await f.db.sessionExists("session-player"), true);
		assert.deepEqual(f.revocations, []);
		assert.equal(errors.mock.callCount(), 1);
	});
}

test("sign-out verification failure returns 503 without clearing cookies", async t => {
	const errors = t.mock.method(console, "error", () => {});
	const f = await setup(t);
	f.deps.auth.handler = signOutSession(f);
	const cause = new Error("D1 unavailable");
	f.deps.db.sessionExists = async id => {
		assert.equal(id, "session-player");
		throw cause;
	};
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 503);
	assert.equal(response.headers.has("Set-Cookie"), false);
	assert.deepEqual(await response.json(), { error: "sign-out incomplete" });
	assert.deepEqual(f.revocations, []);
	assert.deepEqual(errors.mock.calls.map(call => call.arguments), [
		["sign-out verification failed", player.id, cause],
	]);
});

test("retry after incomplete sign-out succeeds once the original session is deleted", async t => {
	t.mock.method(console, "error", () => {});
	const f = await setup(t);
	const authResponse = signOutSession(f);
	f.deps.auth.handler = authResponse;
	assert.equal((await f.request("/api/auth/sign-out", "POST", {})).status, 503);
	f.deps.auth.handler = async () => {
		f.sqlite.prepare("DELETE FROM session WHERE id = ?").run("session-player");
		f.login(null);
		return authResponse();
	};
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Set-Cookie"), "session=; Max-Age=0");
	assert.deepEqual(await response.json(), { signedOut: true });
	assert.equal(await f.db.sessionExists("session-player"), false);
	assert.deepEqual(f.revocations, [["lobby", player.id]]);
});

test("sign-out without a session preserves the auth response without querying D1", async t => {
	const f = await setup(t);
	f.deps.db.sessionExists = async () => { assert.fail("unexpected session lookup"); };
	f.deps.auth.handler = async () => Response.json({ signedOut: true }, {
		headers: { "Set-Cookie": "session=; Max-Age=0" },
	});
	const response = await f.request("/api/auth/sign-out", "POST", {});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Set-Cookie"), "session=; Max-Age=0");
	assert.deepEqual(await response.json(), { signedOut: true });
	assert.deepEqual(f.revocations, []);
});
