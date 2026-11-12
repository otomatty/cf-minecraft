import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

// Resolve only the runtime-owned modules; exercise WorldDO's real fetch logic.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "cloudflare:workers") {
			return { url: "test:workers", shortCircuit: true };
		}
		if (specifier.endsWith("/wasm/server.wasm")) {
			return { url: "test:wasm", shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url === "test:workers") {
			return {
				format: "module",
				source:
					"export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
				shortCircuit: true,
			};
		}
		if (url === "test:wasm") {
			return { format: "module", source: "export default {}", shortCircuit: true };
		}
		return next(url, context);
	},
});

const { WorldDO } = await import("./world-do.ts");

function fixture(t, synchronousClose = false) {
	const closed: [number, string][] = [];
	const disconnected: number[] = [];
	const connected: number[] = [];
	class Socket extends EventTarget {
		accept() {}
		close(code, reason) {
			closed.push([code, reason]);
			if (synchronousClose) {
				this.dispatchEvent(new Event("close"));
			}
		}
	}
	const originalPair = globalThis.WebSocketPair;
	const originalResponse = globalThis.Response;
	globalThis.WebSocketPair = class {
		0 = new Socket();
		1 = new Socket();
	};
	globalThis.Response = class {
		status: number;
		constructor(_body, init) {
			this.status = init.status;
		}
	};
	t.after(() => {
		globalThis.WebSocketPair = originalPair;
		globalThis.Response = originalResponse;
	});
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	const context = {
		storage: {
			sql: {
				exec(sql: string, ...args: unknown[]) {
					if (args.length === 0) {
						sqlite.exec(sql);
						return { toArray: () => [] };
					}
					const rows = sqlite.prepare(sql).all(...args);
					return { toArray: () => rows };
				},
			},
		},
	};
	const world = new WorldDO(context, {});
	world.ensureCore = () => ({
		connect(id) {
			connected.push(id);
		},
		disconnect(id) {
			disconnected.push(id);
		},
	});
	world.startTicking = () => {};
	const join = (user?: string, authorizedAt: string | null = String(Date.now())) =>
		world.fetch(
			new Request("https://game.example/ws/lobby", {
				headers: {
					Upgrade: "websocket",
					...(user ? { "X-MC-User": user } : {}),
					...(authorizedAt === null ? {} : { "X-MC-Authorized-At": authorizedAt }),
				},
			}),
		);
	return { world, join, connected, disconnected, closed, sqlite, context };
}

test("DO requires the Worker identity header before admitting a connection", async t => {
	const f = fixture(t);
	assert.equal((await f.join()).status, 403);
	assert.deepEqual(f.connected, []);
});

for (const synchronousClose of [false, true]) {
	test(`same-user replacement works at capacity (synchronous close=${synchronousClose})`, async t => {
		const f = fixture(t, synchronousClose);
		for (let i = 0; i < 16; i++) {
			assert.equal((await f.join(`user-${i}`)).status, 101);
		}
		assert.equal((await f.join("another-user")).status, 503);
		const old = f.world.sockets.get(1);
		assert.equal((await f.join("user-0")).status, 101);
		assert.deepEqual(f.closed, [[1008, "logged in elsewhere"]]);
		assert.deepEqual(f.disconnected, [1]);
		assert.equal(f.world.sockets.size, 16);
		old.dispatchEvent(new Event("close"));
		assert.deepEqual(f.disconnected, [1]);
		assert.equal(f.world.sockets.size, 16);
	});
}

for (const synchronousClose of [false, true]) {
	test(`revoke closes only the matching user's sockets (synchronous close=${synchronousClose})`, async t => {
		const f = fixture(t, synchronousClose);
		assert.equal((await f.join("revoked-user")).status, 101);
		assert.equal((await f.join("second-connection")).status, 101);
		assert.equal((await f.join("remaining-user")).status, 101);
		// Exercise every matching connection, even if multiple IDs share a user.
		f.world.users.set(2, "revoked-user");
		for (const id of [1, 2, 3]) {
			f.world.packetCounts.set(id, 1);
		}
		const revokedSockets = [f.world.sockets.get(1), f.world.sockets.get(2)];
		assert.equal(f.world.revoke("unknown-user"), 0);
		assert.equal(f.world.revoke("revoked-user"), 2);
		assert.deepEqual(f.closed, [
			[1008, "access revoked"],
			[1008, "access revoked"],
		]);
		assert.deepEqual(f.disconnected, [1, 2]);
		assert.deepEqual([...f.world.sockets.keys()], [3]);
		assert.deepEqual([...f.world.users], [[3, "remaining-user"]]);
		assert.deepEqual([...f.world.packetCounts], [[3, 1]]);
		for (const socket of revokedSockets) {
			socket.dispatchEvent(new Event("close"));
		}
		assert.equal(f.world.revoke("revoked-user"), 0);
		assert.deepEqual(f.disconnected, [1, 2]);
		assert.equal(f.world.sockets.size, 1);
	});
}

test("DO rejects missing, invalid, and expired authorization timestamps", async t => {
	t.mock.method(Date, "now", () => 100_000);
	const f = fixture(t);
	for (const authorizedAt of [null, "", "not-a-number", "NaN", "Infinity", "100000.5", "69999"]) {
		assert.equal((await f.join("user", authorizedAt)).status, 403);
	}
	assert.deepEqual(f.connected, []);
	assert.equal((await f.join("user", "70000")).status, 101);
});

test("persisted revoke blocks in-flight authorization through the clock-skew window", async t => {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const f = fixture(t);
	assert.equal(f.world.revoke("user"), 0);
	// Reconstruct the DO to prove that revocation survives an instance restart.
	const restarted = new WorldDO(f.context, {});
	restarted.ensureCore = f.world.ensureCore;
	restarted.startTicking = () => {};
	const join = (authorizedAt: string) =>
		restarted.fetch(
			new Request("https://game.example/ws/lobby", {
				headers: {
					Upgrade: "websocket",
					"X-MC-User": "user",
					"X-MC-Authorized-At": authorizedAt,
				},
			}),
		);
	now = 102_001;
	for (const authorizedAt of ["99999", "100000", "101999", "102000"]) {
		assert.equal((await join(authorizedAt)).status, 403);
	}
	assert.deepEqual(f.connected, []);
	assert.equal((await join("102001")).status, 101);
});

test("revoke updates its timestamp and prunes only expired revocations", async t => {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const f = fixture(t);
	f.world.revoke("old-user");
	now = 100_001;
	f.world.revoke("boundary-user");
	now = 132_001;
	f.world.revoke("current-user");
	const rows = f.sqlite.prepare("SELECT user_id, at FROM revocations ORDER BY user_id").all();
	assert.deepEqual(
		rows.map(row => ({ ...row })),
		[
			{ user_id: "boundary-user", at: 100_001 },
			{ user_id: "current-user", at: 132_001 },
		],
	);
	now = 132_002;
	f.world.revoke("current-user");
	assert.equal(
		f.sqlite.prepare("SELECT at FROM revocations WHERE user_id = ?").get("current-user").at,
		now,
	);
});
