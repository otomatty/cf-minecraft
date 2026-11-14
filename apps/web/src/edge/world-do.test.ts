import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RegionCodec } from "../shared/region-codec.ts";

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

function fixture(t, synchronousClose = false, legacy = false) {
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
	if (legacy) {
		sqlite.exec("CREATE TABLE chunks (cx INTEGER NOT NULL, cz INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (cx, cz)) WITHOUT ROWID");
		sqlite.prepare("INSERT INTO chunks VALUES (?, ?, ?)").run(-2, 3, new Uint8Array([1, 2, 3]));
	}
	const context = {
		storage: {
			transactionSync(fn) {
				sqlite.exec("BEGIN");
				try {
					const result = fn();
					sqlite.exec("COMMIT");
					return result;
				} catch (error) {
					sqlite.exec("ROLLBACK");
					throw error;
				}
			},
			sql: {
				exec(sql: string, ...args: unknown[]) {
					if (args.length === 0 && !/^(SELECT|PRAGMA)/i.test(sql.trim())) {
						sqlite.exec(sql);
						return { toArray: () => [] };
					}
					const rows = sqlite.prepare(sql).all(...args.map(arg => arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg));
					return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
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
		assert.equal((await f.join("another-user")).status, 101);
		assert.deepEqual(f.closed, [[1013, "world is full"]]);
		assert.equal(f.connected.length, 16);
		assert.equal(f.world.sockets.size, 16);
		const old = f.world.sockets.get(1);
		assert.equal((await f.join("user-0")).status, 101);
		assert.deepEqual(f.closed, [[1013, "world is full"], [4000, "logged in elsewhere"]]);
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
			[4001, "access revoked"],
			[4001, "access revoked"],
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

for (const synchronousClose of [false, true]) {
	test(`disconnectAll cleans up all sockets once (synchronous close=${synchronousClose})`, async t => {
		const f = fixture(t, synchronousClose);
		await f.join("one");
		await f.join("two");
		const sockets = [...f.world.sockets.values()];
		f.world.packetCounts.set(1, 1);
		assert.equal(f.world.disconnectAll(1012, "debug disconnect"), 2);
		assert.deepEqual(f.closed, [[1012, "debug disconnect"], [1012, "debug disconnect"]]);
		assert.deepEqual(f.disconnected, [1, 2]);
		assert.equal(f.world.sockets.size, 0);
		assert.equal(f.world.users.size, 0);
		assert.equal(f.world.packetCounts.size, 0);
		for (const socket of sockets) socket.dispatchEvent(new Event("close"));
		assert.deepEqual(f.disconnected, [1, 2]);
		assert.equal(f.world.disconnectAll(1012, "debug disconnect"), 0);
	});
}

for (const [data, code, reason] of [
	["text", 4003, "binary packets only"],
	[new ArrayBuffer(257), 4003, "binary packets only"],
]) {
	test(`bad packet closes without reconnect: ${typeof data}`, async t => {
		const f = fixture(t);
		await f.join("user");
		f.world.sockets.get(1).dispatchEvent(new MessageEvent("message", { data }));
		assert.deepEqual(f.closed, [[code, reason]]);
		assert.deepEqual(f.disconnected, [1]);
	});
}

test("packet flood closes without reconnect", async t => {
	const f = fixture(t);
	await f.join("user");
	f.world.packetCounts.set(1, 100);
	f.world.sockets.get(1).dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(1) }));
	assert.deepEqual(f.closed, [[4002, "too many packets"]]);
	assert.deepEqual(f.disconnected, [1]);
});

// Use the same real format implementation as the OPFS tests after build:wasm.
const storageModule = new WebAssembly.Module(readFileSync(new URL("../wasm/server.wasm", import.meta.url)));
function storageCore(world, requests: Array<[number, number]>, dirty = []) {
	world.codec = new RegionCodec(new WebAssembly.Instance(storageModule, {}));
	const loaded = [];
	const missing = [];
	world.core = {
		tick() {}, takeOutbox() { return []; }, takeRequests() { return requests.splice(0); },
		loadChunk(cx, cz, data) { loaded.push([cx, cz, data]); },
		chunkMissing(cx, cz) { missing.push([cx, cz]); },
		takeDirty() { return dirty.shift() ?? null; }, gameTime: 1n, dayTime: 1n,
	};
	return { loaded, missing };
}

test("DO saves compressed chunks and restores them through storage_call", t => {
	const { world, sqlite } = fixture(t);
	const data = new Uint8Array(4096).fill(7);
	const result = storageCore(world, [[-2, 3]], [{ cx: -2, cz: 3, data }]);
	assert.equal(world.save(), 1);
	const row = sqlite.prepare("SELECT data, format FROM chunks").get();
	assert.equal(row.format, 1);
	assert.ok(row.data.length < data.length);
	assert.deepEqual(world.codec.call(3, row.data), data);
	world.step();
	assert.deepEqual(result.loaded, [[-2, 3, data]]);
	assert.deepEqual(result.missing, []);
});

test("DO migrates a legacy table once and compresses legacy rows only on save", t => {
	const { world, sqlite, context } = fixture(t, false, true);
	new WorldDO(context, {}); // Repeated startup must not add the column twice.
	assert.equal(sqlite.prepare("SELECT format FROM chunks").get().format, 0);
	const data = new Uint8Array([1, 2, 3]);
	const result = storageCore(world, [[-2, 3]], [{ cx: -2, cz: 3, data }]);
	world.step();
	assert.deepEqual(result.loaded, [[-2, 3, data]]);
	assert.equal(sqlite.prepare("SELECT format FROM chunks").get().format, 0);
	world.save();
	assert.equal(sqlite.prepare("SELECT format FROM chunks").get().format, 1);
	assert.deepEqual(world.codec.call(3, sqlite.prepare("SELECT data FROM chunks").get().data), data);
});

test("DO reports corrupt compressed chunks as missing with their coordinates", t => {
	const { world, sqlite } = fixture(t);
	const warnings = t.mock.method(console, "warn", () => {});
	const result = storageCore(world, [[-2, 3], [4, 5], [6, 7]]);
	const corrupt = world.codec.call(4, new Uint8Array([1, 2, 3]));
	corrupt[5] ^= 1; // Valid zlib, damaged CRC.
	sqlite.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run(-2, 3, corrupt, 1);
	sqlite.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?)").run(4, 5, new Uint8Array([1]), 1);
	world.step();
	assert.deepEqual(result.loaded, []);
	assert.deepEqual(result.missing, [[-2, 3], [4, 5], [6, 7]]);
	assert.equal(warnings.mock.callCount(), 2);
	assert.deepEqual(warnings.mock.calls[0].arguments.slice(1, 3), [-2, 3]);
});
