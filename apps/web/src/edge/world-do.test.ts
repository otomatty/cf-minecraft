import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { testDB } from "./d1-shim.test.ts";
import { createDB } from "./db.ts";
import { ClientCore, S2C } from "../client/client-core.ts";
import { SERVICE_RESTART } from "../shared/close-codes.ts";
import { ChunkGenCore, Generator, ServerCore } from "../shared/server-core.ts";
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
					"export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
				shortCircuit: true,
			};
		}
		if (url === "test:wasm") {
			return { format: "module", source: `import { readFileSync } from "node:fs"; export default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(new URL("../wasm/server.wasm", import.meta.url).href)})));`, shortCircuit: true };
		}
		return next(url, context);
	},
});

const { WorldDO } = await import("./world-do.ts");

function fixture(t, synchronousClose = false, legacy = false) {
	const closed: [number, string][] = [];
	const disconnected: number[] = [];
	const releaseCalls: Array<[string, number]> = [];
	t.after(() => {
		assert.deepEqual(releaseCalls, disconnected.flatMap(id => [
			["returnCrafting", id], ["clientPosition", id], ["inventoryData", id], ["disconnect", id],
		]));
	});
	const connected: number[] = [];
	const operators: [number, boolean][] = [];
	const teleportPermissions: boolean[] = [];
	const initialPositions: Array<[number, number, number] | undefined> = [];
	const acceptedPositions = new Map<number, [number, number, number]>();
	class Socket extends EventTarget {
		sent: string[] = [];
		send(data: string) { this.sent.push(data); }
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
					for (const row of rows) {
						for (const [column, value] of Object.entries(row)) {
							if (value instanceof Uint8Array) row[column] = Uint8Array.from(value).buffer;
						}
					}
					return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
				},
			},
		},
	};
	const authDB = testDB();
	t.after(authDB.close);
	const world = new WorldDO(context, { DB: authDB.db });
	const core = {
		returnCrafting(id) { releaseCalls.push(["returnCrafting", id]); },
		inventoryData(id) { releaseCalls.push(["inventoryData", id]); return undefined; },
		connect(id, allowTeleport, position) {
			connected.push(id);
			teleportPermissions.push(allowTeleport);
			initialPositions.push(position);
		},
		clientPosition(id) {
			releaseCalls.push(["clientPosition", id]);
			return acceptedPositions.get(id);
		},
		disconnect(id) {
			releaseCalls.push(["disconnect", id]);
			disconnected.push(id);
		},
		setOperator(id, operator) { operators.push([id, operator]); },
		setGameMode() {},
		flushEntityChanges() {},
		takeDirty() { return null; },
		gameTime: 1n,
		dayTime: 1n,
	};
	world.ensureCore = function () { return this.core ??= core; };
	world.startTicking = () => {};
	const joinWorld = (target: WorldDO) => (user?: string, authorizedAt: string | null = String(Date.now()), session?: string, encodedName?: string, gameMode?: string, gameModeRevision?: string, role?: string) =>
		target.fetch(
			new Request("https://game.example/ws/lobby", {
				headers: {
					Upgrade: "websocket",
					...(session ? { "X-MC-Session": session } : {}),
					...(encodedName !== undefined ? { "X-MC-Name": encodedName } : {}),
					...(gameMode !== undefined ? { "X-MC-Game-Mode": gameMode } : {}),
					...(gameModeRevision !== undefined ? { "X-MC-Game-Mode-Revision": gameModeRevision } : {}),
					...(role !== undefined ? { "X-MC-Role": role } : {}),
					...(user ? { "X-MC-User": user } : {}),
					...(authorizedAt === null ? {} : { "X-MC-Authorized-At": authorizedAt }),
				},
			}),
		);
	return { world, join: joinWorld(world), joinWorld, initialPositions, acceptedPositions, teleportPermissions, operators, connected, disconnected, closed, sqlite, context, authDB };
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
	[new Uint8Array(1028).fill(0x12, 0, 1).buffer, 4003, "binary packets only"],
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

for (const synchronousClose of [false, true]) {
	test(`DO closes only the mismatched Hello and frees its slot (synchronous close=${synchronousClose})`, async t => {
		const f = fixture(t, synchronousClose);
		delete f.world.ensureCore;
		f.world.env.GEN_OFFLOAD = "0";
		f.world.setMeta("generator", String(Generator.Flat));
		await f.join("old-client");
		await f.join("current-client");
		assert.equal(f.world.sockets.size, 2);
		assert.equal(f.world.core.clientCount, 2);
		const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		const matching = client.encodeHello(2);
		const mismatched = matching.slice();
		mismatched[1] = 0; // Replace the single-byte protocol varint.
		const wrongSocket = f.world.sockets.get(1);
		const rightSocket = f.world.sockets.get(2);
		wrongSocket.dispatchEvent(new MessageEvent("message", { data: mismatched.buffer }));
		rightSocket.dispatchEvent(new MessageEvent("message", { data: matching.buffer }));
		f.world.lastAccessCheck = Date.now();
		f.world.step();
		assert.deepEqual(f.closed, [[4004, "protocol mismatch"]]);
		assert.deepEqual([...f.world.sockets.keys()], [2]);
		assert.equal(f.world.core.clientCount, 1);
		assert.ok(rightSocket.sent.some(frame => typeof frame !== "string" && client.packet(frame) === S2C.Welcome));
		wrongSocket.dispatchEvent(new Event("close"));
		assert.equal(f.world.core.clientCount, 1);
	});
}

function storageCore(world, requests: Array<[number, number]>, dirty = []) {
	world.codec = new RegionCodec(new WebAssembly.Instance(storageModule, {}));
	const loaded = [];
	const missing = [];
	world.core = {
		...world.core,
		tick() {}, takeOutbox() { return []; }, takeRequests() { return requests.splice(0); },
		takeProtocolMismatches() { return []; },
		loadChunk(cx, cz, data) { loaded.push([cx, cz, data]); },
		chunkMissing(cx, cz) { missing.push([cx, cz]); },
		flushEntityChanges() {}, takeDirty() { return dirty.shift() ?? null; }, gameTime: 1n, dayTime: 1n,
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

test("DO retries failed compression with the newest snapshot for each chunk", t => {
	const { world, sqlite } = fixture(t);
	const warnings = t.mock.method(console, "warn", () => {});
	const first = { cx: 0, cz: 0, data: new Uint8Array([1, 2, 3]) };
	const second = { cx: 1, cz: 0, data: new Uint8Array([4, 5, 6]) };
	const newest = { ...first, data: new Uint8Array([7, 8, 9]) };
	const dirty = [first, second];
	storageCore(world, [], dirty);
	const call = world.codec.call.bind(world.codec);
	const failure = t.mock.method(world.codec, "call", (op, data) => {
		if (op === 4 && data === second.data) throw new Error("compression failed");
		return call(op, data);
	});

	assert.equal(world.save(), null);
	assert.deepEqual(sqlite.prepare("SELECT data FROM chunks").all(), []);
	assert.deepEqual(dirty, []);
	assert.equal(warnings.mock.callCount(), 1);
	failure.mock.restore();

	dirty.push(newest);
	assert.equal(world.save(), 2);
	const rows = sqlite.prepare("SELECT data FROM chunks ORDER BY cx").all();
	assert.deepEqual(rows.map(row => call(3, row.data)), [newest.data, second.data]);
	assert.equal(world.save(), 0);
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

// Exercise the real batched SQL against the auth migration, with a controllable clock.
async function accessFixture(t, synchronousClose = false) {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const f = fixture(t, synchronousClose);
	const sql = f.authDB.sqlite;
	for (const user of ["owner", "player", "other"]) {
		f.authDB.user(user, `${user.toUpperCase()}@example.com`);
		sql.prepare("INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, 0, 0, ?)")
			.run(`session-${user}`, new Date(1_000_000).toISOString(), `token-${user}`, user);
	}
	sql.prepare("INSERT INTO world(name, owner_id, created_at) VALUES ('lobby', 'owner', 0)").run();
	for (const user of ["owner", "player", "other"]) {
		sql.prepare("INSERT INTO world_member VALUES ('lobby', ?, 'operator', 0)").run(`${user}@example.com`);
		await f.join(user, String(now), `session-${user}`);
	}
	await f.join("dev:anonymous");
	storageCore(f.world, []);
	let queries = 0;
	const prepare = f.authDB.db.prepare.bind(f.authDB.db);
	t.mock.method(f.authDB.db, "prepare", (...args) => {
		queries++;
		return prepare(...args);
	});
	const tick = async (elapsed = 60_000) => {
		now += elapsed;
		f.world.step();
		// Let the async query and its finally handler settle.
		await new Promise(resolve => setImmediate(resolve));
	};
	return { ...f, sql, tick, queries: () => queries };
}

for (const synchronousClose of [false, true]) {
	test(`periodic check drops deleted sessions with full cleanup (synchronous close=${synchronousClose})`, async t => {
		const f = await accessFixture(t, synchronousClose);
		f.sql.prepare("DELETE FROM session WHERE userId = 'player'").run();
		f.world.packetCounts.set(2, 3);
		await f.tick(59_999);
		assert.equal(f.queries(), 0);
		await f.tick(1);
		assert.equal(f.queries(), 1);
		assert.deepEqual(f.closed, [[4001, "access revoked"]]);
		assert.deepEqual(f.disconnected, [2]);
		assert.equal(f.world.users.has(2), false);
		assert.equal(f.world.sessions.has(2), false);
		assert.equal(f.world.packetCounts.has(2), false);
		assert.deepEqual([...f.world.sockets.keys()], [1, 3, 4]);
	});
}

test("periodic check requires membership even for the owner", async t => {
	const f = await accessFixture(t);
	f.sql.prepare("DELETE FROM world_member WHERE email IN ('owner@example.com', 'player@example.com')").run();
	await f.tick();
	assert.equal(f.queries(), 1);
	assert.deepEqual(f.closed, [[4001, "access revoked"], [4001, "access revoked"]]);
	assert.deepEqual(f.disconnected, [1, 2]);
	assert.deepEqual([...f.world.users.values()], ["other", "dev:anonymous"]);
});

test("valid sessions and development connections remain connected", async t => {
	const f = await accessFixture(t);
	await f.tick();
	await f.tick();
	assert.equal(f.queries(), 2);
	assert.deepEqual(f.closed, []);
	assert.equal(f.world.sockets.size, 4);
});

test("recheck refreshes operator from the member role without disconnecting", async t => {
	const f = await accessFixture(t);
	assert.deepEqual(f.operators, [[1, false], [2, false], [3, false], [4, false]]);
	f.operators.length = 0;
	await f.tick();
	assert.deepEqual(f.operators, [[1, true], [2, true], [3, true]]);
	assert.equal(f.world.sockets.size, 4);
	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'player@example.com'").run();
	f.operators.length = 0;
	await f.tick();
	assert.deepEqual(f.operators, [[1, true], [2, false], [3, true]]);
	assert.deepEqual(f.closed, []);
	assert.equal(f.world.sockets.size, 4);
});

test("a pending recheck preserves a newer role and still revokes invalid sessions", async t => {
	const f = await accessFixture(t);
	f.sql.prepare("DELETE FROM session WHERE userId = 'other'").run();
	let resolveQuery;
	const pending = new Promise(resolve => { resolveQuery = resolve; });
	const prepare = f.authDB.db.prepare.bind(f.authDB.db);
	t.mock.method(f.authDB.db, "prepare", prepare).mock.mockImplementationOnce(sql => ({
		bind(...args) {
			return {
				async all() {
					const result = await prepare(sql).bind(...args).all();
					await pending;
					return result;
				},
			};
		},
	}));
	f.operators.length = 0;
	await f.tick();
	assert.equal(f.queries(), 1);
	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'player@example.com'").run();
	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'other@example.com'").run();
	assert.equal(await f.world.refreshRole("player", "lobby"), 1);
	assert.equal(await f.world.refreshRole("other", "lobby"), 1);
	assert.equal(f.queries(), 3);
	assert.deepEqual(f.operators, [[2, false], [3, false]]);
	resolveQuery();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.operators, [[2, false], [3, false], [1, true]]);
	assert.deepEqual(f.closed, [[4001, "access revoked"]]);
	assert.deepEqual(f.disconnected, [3]);
});

test("expired sessions and sessions belonging to another user are rejected", async t => {
	const f = await accessFixture(t);
	f.sql.prepare("UPDATE session SET expiresAt = ? WHERE userId = 'player'")
		.run(new Date(160_000).toISOString());
	f.sql.prepare("UPDATE session SET userId = 'other' WHERE id = 'session-owner'").run();
	await f.tick();
	assert.deepEqual(f.disconnected, [1, 2]);
	assert.deepEqual(f.closed, [[4001, "access revoked"], [4001, "access revoked"]]);
});

test("D1 failure keeps everyone connected and retries at the next interval", async t => {
	const errors = t.mock.method(console, "error", () => {});
	const f = await accessFixture(t);
	f.sql.prepare("DELETE FROM session WHERE userId = 'player'").run();
	const prepare = f.authDB.db.prepare.bind(f.authDB.db);
	const failure = t.mock.method(f.authDB.db, "prepare", () => { throw new Error("D1 unavailable"); });
	await f.tick();
	assert.equal(errors.mock.callCount(), 1);
	assert.deepEqual(f.closed, []);
	assert.equal(f.world.sockets.size, 4);
	failure.mock.mockImplementation(prepare);
	await f.tick(59_999);
	assert.deepEqual(f.closed, []);
	await f.tick(1);
	assert.deepEqual(f.closed, [[4001, "access revoked"]]);
});

test("a pending check does not stop ticks or overlap, and ignores replacement connections", async t => {
	const f = await accessFixture(t);
	let resolveQuery;
	const pending = new Promise(resolve => { resolveQuery = resolve; });
	const originalPrepare = f.authDB.db.prepare.bind(f.authDB.db);
	let queries = 0;
	const delayed = t.mock.method(f.authDB.db, "prepare", () => ({
		bind() { return this; },
		all() { queries++; return pending; },
	}));
	await f.tick();
	let ticks = 0;
	f.world.core.tick = () => { ticks++; };
	await f.tick();
	assert.equal(ticks, 1);
	assert.equal(queries, 1);
	await f.join("player", String(Date.now()), "replacement-session");
	resolveQuery({ success: true, results: [] });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.closed, [
		[4000, "logged in elsewhere"], [4001, "access revoked"], [4001, "access revoked"],
	]);
	assert.deepEqual([...f.world.users.values()], ["dev:anonymous", "player"]);
	assert.equal(f.world.sessions.get(5), "replacement-session");
	delayed.mock.mockImplementation(originalPrepare);
	await f.tick();
	assert.deepEqual(f.closed.at(-1), [4001, "access revoked"]);
});

test("connections without sessions do not query D1", async t => {
	const f = fixture(t);
	await f.join("dev:anonymous");
	storageCore(f.world, []);
	t.mock.method(f.authDB.db, "prepare", () => { assert.fail("unexpected D1 query"); });
	await f.world.recheckAccess();
	assert.deepEqual(f.closed, []);
});


test("only ops and dev connections receive teleport permission", async t => {
	const f = fixture(t);
	for (const user of ["ops:operator", "dev:anonymous", "player", "user:ops:spoof", "ops", "dev"]) {
		const response = await f.join(user);
		assert.equal(response.status, 101);
	}
	assert.deepEqual(f.teleportPermissions, [true, true, false, false, false, false]);
});


test("X-MC-Role operator is the only value that grants operator", async t => {
	const f = fixture(t);
	for (const [user, role] of [
		["ops:1", "operator"],
		["player", "player"],
		["spoof", "OPERATOR"],
		["plain", undefined],
	] as const) {
		assert.equal((await f.join(user, undefined, undefined, undefined, undefined, undefined, role)).status, 101);
	}
	assert.deepEqual(f.operators, [[1, true], [2, false], [3, false], [4, false]]);
});

test("refreshRole updates every current connection for that user and does not disconnect", async t => {
	const f = fixture(t);
	f.authDB.user("alice", "Alice@example.com");
	f.authDB.user("bob", "Bob@example.com");
	const db = createDB(f.authDB.db);
	await db.createWorld("lobby", "alice", "alice@example.com");
	await db.putMember("lobby", "bob@example.com", "player");
	assert.equal((await f.join("alice")).status, 101);
	assert.equal((await f.join("bob")).status, 101);
	assert.equal(await f.world.refreshRole("alice", "lobby"), 1);
	assert.equal(await f.world.refreshRole("bob", "lobby"), 1);
	f.world.users.set(99, "alice");
	await db.putMember("lobby", "alice@example.com", "player");
	assert.equal(await f.world.refreshRole("alice", "lobby"), 2);
	assert.equal(await f.world.refreshRole("nobody", "lobby"), 0);
	assert.equal(f.world.sockets.size, 2);
	assert.deepEqual(f.closed, []);
	assert.deepEqual(f.disconnected, []);
	assert.deepEqual(f.operators, [
		[1, false], [2, false], [1, true], [2, false], [1, false], [99, false],
	]);
});

test("refreshRole returns the newer applied result when D1 responses finish out of order", async t => {
	const f = await accessFixture(t);
	const prepare = f.authDB.db.prepare.bind(f.authDB.db);
	const pending = Promise.withResolvers<void>();
	t.mock.method(f.authDB.db, "prepare", prepare).mock.mockImplementationOnce(sql => ({
		bind(...args) {
			return {
				async all() {
					const result = await prepare(sql).bind(...args).all();
					await pending.promise;
					return result;
				},
			};
		},
	}));
	f.operators.length = 0;
	const older = f.world.refreshRole("player", "lobby");
	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'player@example.com'").run();
	await f.tick(1_000);
	const updated = await f.world.refreshRole("player", "lobby");
	pending.resolve();
	assert.equal(updated, 1);
	assert.equal(await older, updated);
	assert.deepEqual(f.operators, [[2, false]]);
	assert.deepEqual({ ...f.sqlite.prepare("SELECT role, at FROM role_changes WHERE user_id = 'player'").get() }, {
		role: "player", at: 101_000,
	});
	assert.equal(f.world.roleRefreshes.size, 0);
});

test("refreshRole propagates a newer failed refresh to an older caller", async t => {
	const f = await accessFixture(t);
	await f.world.recheckAccess();
	assert.deepEqual(f.operators.slice(-3), [[1, true], [2, true], [3, true]]);
	f.operators.length = 0;
	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'player@example.com'").run();
	const prepare = f.authDB.db.prepare.bind(f.authDB.db);
	const pending = Promise.withResolvers<void>();
	const query = t.mock.method(f.authDB.db, "prepare", prepare);
	query.mock.mockImplementationOnce(sql => ({
		bind(...args) {
			return {
				async all() {
					const result = await prepare(sql).bind(...args).all();
					await pending.promise;
					return result;
				},
			};
		},
	}));
	const older = f.world.refreshRole("player", "lobby");
	query.mock.mockImplementationOnce(() => ({
		bind() { return this; },
		async all() { return { success: false, results: [] }; },
	}));
	await assert.rejects(f.world.refreshRole("player", "lobby"), /Role refresh query failed/);
	pending.resolve();
	await assert.rejects(older, /Role refresh query failed/);
	assert.deepEqual(f.operators, []);
	assert.deepEqual(f.sqlite.prepare("SELECT * FROM role_changes").all(), []);
	assert.equal(f.world.roleRefreshes.size, 0);
});

test("refreshRole follows a third refresh while waiting on the second", async t => {
	const f = await accessFixture(t);
	const firstQuery = Promise.withResolvers<{ success: boolean; results: { role: string }[] }>();
	const secondQuery = Promise.withResolvers<{ success: boolean; results: { role: string }[] }>();
	const query = t.mock.method(f.authDB.db, "prepare");
	for (const [index, pending] of [firstQuery, secondQuery].entries()) {
		query.mock.mockImplementationOnce(() => ({
			bind() { return this; },
			all() { return pending.promise; },
		}), index);
	}
	f.operators.length = 0;
	let firstResult: number | undefined;
	const first = f.world.refreshRole("player", "lobby").then(changed => { firstResult = changed; });
	const second = f.world.refreshRole("player", "lobby");
	firstQuery.resolve({ success: true, results: [{ role: "operator" }] });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(firstResult, undefined);
	assert.deepEqual(f.operators, []);

	f.sql.prepare("UPDATE world_member SET role = 'player' WHERE email = 'player@example.com'").run();
	const third = await f.world.refreshRole("player", "lobby");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(third, 1);
	assert.equal(firstResult, third);
	secondQuery.resolve({ success: true, results: [{ role: "operator" }] });
	assert.equal(await second, third);
	await first;
	assert.deepEqual(f.operators, [[2, false]]);
	assert.equal(f.world.roleRefreshes.size, 0);
});

test("refreshRole uses player for a non-member or unverified user", async t => {
	const f = await accessFixture(t);
	f.sql.prepare("DELETE FROM world_member WHERE email = 'player@example.com'").run();
	const db = createDB(f.authDB.db);
	await db.createWorld("other-world", "player", "player@example.com");
	f.sql.prepare('UPDATE "user" SET emailVerified = 0 WHERE id = ?').run("other");
	f.operators.length = 0;
	assert.equal(await f.world.refreshRole("player", "lobby"), 1);
	assert.equal(await f.world.refreshRole("other", "lobby"), 1);
	assert.deepEqual(f.operators, [[2, false], [3, false]]);
});

test("refreshRole propagates D1 failures without applying any role", async t => {
	const f = await accessFixture(t);
	const query = t.mock.method(f.authDB.db, "prepare", () => ({
		bind() { return this; },
		async all() { return { success: false, results: [] }; },
	}));
	f.operators.length = 0;
	await assert.rejects(f.world.refreshRole("player", "lobby"), /Role refresh query failed/);
	query.mock.mockImplementationOnce(() => { throw new Error("D1 unavailable"); });
	await assert.rejects(f.world.refreshRole("player", "lobby"), /D1 unavailable/);
	assert.deepEqual(f.operators, []);
	assert.deepEqual(f.sqlite.prepare("SELECT * FROM role_changes").all(), []);
});

test("refreshRole rejects a different world before querying D1 once a player has joined", async t => {
	const f = fixture(t);
	assert.equal((await f.join("player")).status, 101);
	const prepare = t.mock.method(f.authDB.db, "prepare");
	await assert.rejects(f.world.refreshRole("player", "other-world"), /World name mismatch/);
	assert.equal(prepare.mock.callCount(), 0);
	assert.deepEqual(f.operators, [[1, false]]);
	assert.deepEqual(f.sqlite.prepare("SELECT * FROM role_changes").all(), []);
});

test("refreshRole rejects a different world when the first player joins during the query", async t => {
	const f = fixture(t);
	const pending = Promise.withResolvers<{ success: boolean; results: { role: string }[] }>();
	t.mock.method(f.authDB.db, "prepare", () => ({
		bind() { return this; },
		all() { return pending.promise; },
	}));
	const refreshing = f.world.refreshRole("player", "other-world");
	assert.equal((await f.join("player")).status, 101);
	pending.resolve({ success: true, results: [{ role: "operator" }] });
	await assert.rejects(refreshing, /World name mismatch/);
	assert.deepEqual(f.operators, [[1, false]]);
	assert.deepEqual(f.sqlite.prepare("SELECT * FROM role_changes").all(), []);
});

test("a role change overrides join authorization through the clock-skew window", async t => {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const f = fixture(t);
	f.authDB.user("owner", "owner@example.com");
	f.authDB.user("player", "player@example.com");
	const db = createDB(f.authDB.db);
	await db.createWorld("lobby", "owner", "owner@example.com");
	await db.putMember("lobby", "player@example.com", "operator");
	assert.equal(await f.world.refreshRole("player", "lobby"), 0);
	assert.equal(f.sqlite.prepare("SELECT role FROM role_changes WHERE user_id = 'player'").get()?.role, "operator");
	await db.putMember("lobby", "player@example.com", "player");
	assert.equal(await f.world.refreshRole("player", "lobby"), 0);
	assert.equal(f.world.core, null);
	now = 102_001;
	for (const authorizedAt of ["99999", "102000", "102001"]) {
		assert.equal((await f.join("player", authorizedAt, undefined, undefined, undefined, undefined, "operator")).status, 101);
	}
	assert.deepEqual(f.operators, [[1, false], [2, false], [3, true]]);
});

for (const event of ["close", "error"]) {
	test(`reconnect after ${event} restores only the same user's accepted position`, async t => {
		const f = fixture(t);
		await f.join("player");
		const position: [number, number, number] = [3000.5, 100, -3000.5];
		f.acceptedPositions.set(1, position);
		f.world.sockets.get(1).dispatchEvent(new Event(event));
		assert.deepEqual(f.disconnected, [1]);
		await f.join("other-player");
		await f.join("player");
		assert.deepEqual(f.initialPositions, [undefined, undefined, position]);
		assert.deepEqual(f.teleportPermissions, [false, false, false]);
	});
}

for (const synchronousClose of [false, true]) {
	test(`replacement connection captures position before disconnect (synchronous close=${synchronousClose})`, async t => {
		const f = fixture(t, synchronousClose);
		await f.join("player");
		const old = f.world.sockets.get(1);
		const position: [number, number, number] = [3000.5, 100, 0.5];
		f.acceptedPositions.set(1, position);
		await f.join("player");
		assert.deepEqual(f.initialPositions, [undefined, position]);
		// A late close from the old socket cannot overwrite the new connection.
		old.dispatchEvent(new Event("close"));
		const latest: [number, number, number] = [3001, 100, 0.5];
		f.acceptedPositions.set(2, latest);
		f.world.sockets.get(2).dispatchEvent(new Event("close"));
		await f.join("player");
		assert.deepEqual(f.initialPositions, [undefined, position, latest]);
	});
}

test("debug disconnect remembers positions and debug evict restores them from SQLite", async t => {
	const f = fixture(t);
	await f.join("player");
	const position: [number, number, number] = [3000.5, 100, 0.5];
	f.acceptedPositions.set(1, position);
	f.world.disconnectAll(1012, "restart");
	await f.join("player");
	assert.deepEqual(f.initialPositions, [undefined, position]);
	f.acceptedPositions.set(2, position);
	f.world.evict();
	assert.equal(f.world.savedPlayers.size, 0);
	assert.equal(f.world.pendingPlayers.size, 0);
	await f.join("player");
	assert.deepEqual(f.initialPositions, [undefined, position, position]);
});

function playerStorageFixture(t) {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.env.GEN_OFFLOAD = "0";
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const module = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(module, {}));
	const editPlayer = (id: number, count: number) => {
		const core = f.world.core;
		const [x, y, z] = core.clientPosition(id);
		const position = [x + 0.25, y, z] as const;
		const previous = core.inventoryData(id);
		core.packet(id, client.encodeHello(2));
		f.world.step();
		core.packet(id, client.encodePos(...position, 0, 0));
		core.packet(id, client.encodeCreativeSetSlot(0, 1, count));
		f.world.step();
		const inventory = core.inventoryData(id);
		assert.deepEqual(core.clientPosition(id), position);
		assert.notDeepEqual(inventory, previous);
		return { position, inventory };
	};
	return { ...f, client, editPlayer };
}

for (const prefix of ["dev:", "ops:"]) {
	test(`DO skips player storage for ${prefix} connections`, async t => {
		const f = playerStorageFixture(t);
		const sql = t.mock.method(f.context.storage.sql, "exec");
		const user = `${prefix}player`;
		const rows = () => f.sqlite.prepare("SELECT * FROM players").all();
		assert.equal((await f.join(user)).status, 101);
		const spawn = f.world.core.clientPosition(1);
		const defaultInventory = f.world.core.inventoryData(1);
		const { position, inventory } = f.editPlayer(1, 23);
		f.world.core.setTime(99n, 6000n);
		f.world.step();
		assert.equal(f.world.meta("gameTime"), "100");
		assert.deepEqual(rows(), []);
		assert.equal(f.world.savedPlayers.size, 0);

		f.world.sockets.get(1).dispatchEvent(new Event("close"));
		assert.equal(f.world.pendingPlayers.size, 0);
		f.world.evict();
		assert.deepEqual(rows(), []);

		// A row left by an earlier version is ignored even if the ID matches.
		f.sqlite.prepare("INSERT INTO players VALUES (?, ?, ?, ?, ?, ?)").run(user, ...position, inventory, Date.now());
		assert.equal((await f.join(user)).status, 101);
		assert.deepEqual(f.world.core.clientPosition(2), spawn);
		assert.deepEqual(f.world.core.inventoryData(2), defaultInventory);
		assert.equal(f.world.savedPlayers.size, 0);
		assert.deepEqual(sql.mock.calls.filter(call => /\bplayers\b/i.test(call.arguments[0])), []);
	});
}

test("DO restores a disconnected user's position and inventory after eviction", async t => {
	const f = playerStorageFixture(t);
	assert.equal((await f.join("player")).status, 101);
	const spawn = f.world.core.clientPosition(1);
	const defaultInventory = f.world.core.inventoryData(1);
	const { position, inventory } = f.editPlayer(1, 23);
	f.world.sockets.get(1).dispatchEvent(new Event("close"));
	f.world.evict();
	assert.equal(f.world.savedPlayers.size, 0);
	assert.equal(f.world.pendingPlayers.size, 0);
	assert.equal((await f.join("player")).status, 101);
	assert.deepEqual(f.world.core.clientPosition(2), position);
	assert.deepEqual(f.world.core.inventoryData(2), inventory);
	assert.equal((await f.join("another-user")).status, 101);
	assert.deepEqual(f.world.core.clientPosition(3), spawn);
	assert.deepEqual(f.world.core.inventoryData(3), defaultInventory);
});

test("DO autosaves connected players and skips identical rows across saves and instances", async t => {
	const f = playerStorageFixture(t);
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	assert.equal((await f.join("player")).status, 101);
	const { position, inventory } = f.editPlayer(1, 23);
	f.world.core.setTime(99n, 6000n);
	f.world.step();
	const row = () => f.sqlite.prepare("SELECT * FROM players WHERE user_id = ?").get("player");
	assert.equal(row().saved_at, now);
	const saved = row();
	now += 5000;
	f.world.core.setTime(199n, 6100n);
	f.world.step();
	assert.deepEqual(row(), saved);
	f.editPlayer(1, 25);
	assert.notDeepEqual(f.world.core.clientPosition(1), position);
	assert.deepEqual(row(), saved);

	const restarted = new WorldDO(f.context, f.world.env);
	restarted.startTicking = () => {};
	assert.equal((await f.joinWorld(restarted)("player")).status, 101);
	assert.deepEqual(restarted.core.clientPosition(1), position);
	assert.deepEqual(restarted.core.inventoryData(1), inventory);
	assert.equal(restarted.core.gameTime, 200n);
	restarted.save();
	assert.deepEqual(row(), saved);
	assert.equal(f.world.sockets.size, 1, "the original socket never disconnected or flushed");

	now += 5000;
	restarted.core.packet(1, f.client.encodeHello(2));
	restarted.core.packet(1, f.client.encodeCreativeSetSlot(0, 1, 24));
	restarted.core.setTime(299n, 6200n);
	restarted.step();
	const updated = row();
	assert.equal(updated.saved_at, now);
	assert.deepEqual([updated.x, updated.y, updated.z], position);
	assert.notDeepEqual(updated.inventory, inventory);
	assert.deepEqual(updated.inventory, restarted.core.inventoryData(1));
});

test("DO falls back to spawn and mode defaults for malformed player rows", async t => {
	const f = playerStorageFixture(t);
	assert.equal((await f.join("new-player")).status, 101);
	const core = f.world.core;
	const spawn = core.clientPosition(1);
	const defaultInventory = core.inventoryData(1);
	const insert = f.sqlite.prepare("INSERT INTO players VALUES (?, ?, ?, ?, ?, ?)");
	for (const [i, x] of ["NaN", Infinity].entries()) {
		const user = `broken-player-${i}`;
		insert.run(user, x, 100, 1, new Uint8Array([5, 0, 1]), Date.now());
		assert.equal((await f.join(user)).status, 101);
		assert.deepEqual(core.clientPosition(i + 2), spawn);
		assert.deepEqual(core.inventoryData(i + 2), defaultInventory);
	}
});

test("DO retries player rows together with chunks and clock after a rollback", async t => {
	const f = playerStorageFixture(t);
	const warnings = t.mock.method(console, "warn", () => {});
	assert.equal((await f.join("player")).status, 101);
	const { position, inventory } = f.editPlayer(1, 23);
	f.world.sockets.get(1).dispatchEvent(new Event("close"));
	const data = new Uint8Array([1, 2, 3]);
	t.mock.method(f.world.core, "takeDirty", () => ({ cx: -2, cz: 3, data }), { times: 1 });
	const storage = f.context.storage;
	const transactionSync = storage.transactionSync.bind(storage);
	t.mock.method(storage, "transactionSync", fn => transactionSync(() => {
		fn();
		throw new Error("write rolled back");
	}), { times: 1 });

	const query = (sql: string) => f.sqlite.prepare(sql).all();
	assert.equal(f.world.save(), null);
	assert.deepEqual(query("SELECT * FROM players"), []);
	assert.deepEqual(query("SELECT * FROM chunks"), []);
	assert.deepEqual(query("SELECT * FROM meta WHERE key IN ('gameTime', 'dayTime')"), []);
	assert.equal(warnings.mock.callCount(), 1);

	assert.equal(f.world.save(), 1);
	const [row] = query("SELECT * FROM players");
	assert.deepEqual([row.x, row.y, row.z], position);
	assert.deepEqual(row.inventory, inventory);
	assert.equal(query("SELECT * FROM chunks").length, 1);
	assert.equal(query("SELECT * FROM meta WHERE key IN ('gameTime', 'dayTime')").length, 2);
});

test("DO skips oversized inventory blobs and still saves the position", async t => {
	const f = playerStorageFixture(t);
	const warnings = t.mock.method(console, "warn", () => {});
	assert.equal((await f.join("player")).status, 101);
	const { position } = f.editPlayer(1, 23);
	t.mock.method(f.world.core, "inventoryData", () => new Uint8Array(4097), { times: 1 });
	f.world.save();
	const row = f.sqlite.prepare("SELECT x, y, z, inventory FROM players WHERE user_id = ?").get("player");
	assert.deepEqual([row.x, row.y, row.z], position);
	assert.equal(row.inventory, null);
	assert.equal(warnings.mock.callCount(), 1);
});

test("real WASM ABI restores a normal user's position and exposes only accepted movement", () => {
	const core = ServerCore.fromModule(storageModule);
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	core.start(1n, Generator.Flat);
	const position: [number, number, number] = [3000.5, 100, -3000.5];
	core.connect(1, false, position);
	assert.deepEqual(core.clientPosition(1), position);
	assert.equal(core.clientPosition(2), undefined);
	core.packet(1, client.encodeHello(2));
	core.tick();
	const next: [number, number, number] = [3000.7, 100, -3000.5];
	core.packet(1, client.encodePos(...next, 0, 0));
	assert.deepEqual(core.clientPosition(1), position);
	core.tick();
	assert.deepEqual(core.clientPosition(1), next);
	core.packet(1, client.encodePos(10000, 100, 0, 0, 0));
	core.tick();
	assert.deepEqual(core.clientPosition(1), next);
	core.disconnect(1);
	assert.equal(core.clientPosition(1), undefined);
	core.connect(2, false, [NaN, 100, 0.5]);
	core.connect(3);
	assert.deepEqual(core.clientPosition(2), core.clientPosition(3));
});


test("DO saves Terrain for new worlds and DebugHills for existing seed-only worlds", t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	const get = key => f.sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	for (const [seed, generator, expected] of [
		[null, null, Generator.Terrain],
		["2026", null, Generator.DebugHills],
		["2026", "0", Generator.Flat],
		["2026", "2", Generator.Terrain],
		["2026", "99", 99],
		[null, "1", Generator.Terrain],
	]) {
		f.sqlite.exec("DELETE FROM meta");
		if (seed !== null) f.world.setMeta("seed", seed);
		if (generator !== null) f.world.setMeta("generator", generator);
		f.world.core = null;
		const core = f.world.ensureCore();
		assert.equal(get("generator"), String(expected));
		const savedSeed = get("seed");
		const reference = ServerCore.fromModule(storageModule);
		reference.start(BigInt(savedSeed), expected);
		const initialHash = reference.stateHash();
		assert.equal(core.stateHash(), initialHash);
		const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		for (const server of [core, reference]) {
			server.connect(1, false);
			server.packet(1, client.encodeHello(2));
			server.tick();
		}
		assert.equal(core.stateHash(), reference.stateHash(), "restored generator determines new chunks");
		assert.ok(core.loadedChunks > 0);
		f.world.core = null;
		assert.equal(f.world.ensureCore().stateHash(), initialHash);
		assert.equal(get("seed"), savedSeed);
	}
});

test("DO announces the saved generator to clients", async t => {
	const f = fixture(t);
	f.world.generator = Generator.Terrain;
	await f.join("user");
	assert.deepEqual(JSON.parse(f.world.sockets.get(1).sent[0]), { type: "worldInfo", generator: Generator.Terrain });
});


test("WASM biome metadata follows the accepted player column for both hosts", () => {
	const core = ServerCore.fromModule(storageModule);
	for (const gen of [Generator.Flat, Generator.DebugHills]) {
		core.start(2026n, gen);
		core.connect(1, true, [-1000.5,240,2000.5]);
		assert.equal(core.clientBiome(1), "mild_meadow");
	}
	core.start(2026n, Generator.Terrain);
	const names = new Set<string>();
	for (const [i, [x,z]] of [[0,0],[-2048,-2048],[2040,2040],[640,-640]].entries()) {
		core.connect(i+1,true,[x+0.5,240,z+0.5]);
		const name = core.clientBiome(i+1);
		assert.match(name,/^[a-z]+_[a-z]+$/);
		assert.equal(name,core.clientBiome(i+1));
		names.add(name);
	}
	assert.ok(names.size > 1);
});


test("DO sends per-player biome names through stats text metadata", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.setMeta("seed","2026");
	f.world.setMeta("generator",String(Generator.Terrain));
	await f.join("player");
	f.world.lastAccessCheck = Date.now();
	for (let i = 0; i < 20; i++) f.world.step();
	const frames = f.world.sockets.get(1).sent.filter(frame => typeof frame === "string").map(frame => JSON.parse(frame));
	const stats = frames.find(frame => frame.type === "stats")?.stats;
	assert.ok(stats);
	assert.equal(stats.biome, f.world.core.clientBiome(1));
	assert.match(stats.biome,/^[a-z]+_[a-z]+$/);
	assert.equal(stats.persistence,"sqlite");
	assert.equal(stats.msptMean, null);
	assert.equal(stats.msptMax, null);
});

for (const mode of ["external", "disabled", "missing", "rejected"]) {
	test(`DO delivers real WASM chunks with generation ${mode}`, async t => {
		const warnings = t.mock.method(console, "warn", () => {});
		const f = fixture(t);
		delete f.world.ensureCore;
		const gen = ChunkGenCore.fromModule(storageModule);
		f.world.env.GEN_OFFLOAD = mode === "disabled" ? "0" : "1";
		if (mode !== "missing") f.context.exports = { ChunkGen: {
			async generate(seed, generator, cx, cz) {
				if (mode === "rejected") throw new Error("RPC failed");
				return gen.generate(BigInt(seed), generator, cx, cz);
			},
		} };
		await f.join("dev:player");
		const client = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
		f.world.core.packet(1, client.encodeHello(2));
		const socket = f.world.sockets.get(1);
		let consumed = 0;
		for (let i = 0; i < 10; i++) {
			f.world.step();
			await new Promise(resolve => setImmediate(resolve));
			for (const data of socket.sent.slice(consumed)) if (typeof data !== "string") client.packet(data);
			consumed = socket.sent.length;
			if (mode === "external" && i === 0) {
				assert.equal(client.chunkCount, 0);
				assert.equal(f.world.metrics().generation.requested, 8);
			}
			if (mode === "external" && i === 1) {
				assert.ok(client.chunkCount > 0, "pre-tick pump makes completed generation stream in that tick");
			}
		}
		assert.ok(client.chunkCount > 0);
		if (mode === "external") assert.ok(f.world.metrics().generation.delivered > 0);
		if (mode === "rejected") {
			assert.ok(f.world.metrics().generation.fallback > 0);
			assert.equal(warnings.mock.callCount(), 1);
		}
	});
}


test("ChunkGen validates RPC arguments and reuses a generation-only WASM core", async () => {
	const { ChunkGen } = await import("./index.ts");
	const entry = new ChunkGen();
	for (const args of [
		["9223372036854775808", 0, 0, 0], ["-9223372036854775809", 0, 0, 0],
		["1.5", 0, 0, 0], ["", 0, 0, 0], ["1", 3, 0, 0],
		["1", 0, 0.5, 0], ["1", 0, NaN, 0], ["1", 0, 1_875_012, 0],
	]) await assert.rejects(() => entry.generate(...args));
	const expected = ChunkGenCore.fromModule(storageModule);
	for (const seed of ["-9223372036854775808", "9223372036854775807", "2026"])
		assert.deepEqual(await entry.generate(seed, Generator.Flat, -2, 3), expected.generate(BigInt(seed), Generator.Flat, -2, 3));
});

test("DO disables unresponsive generation and streams synchronous fallback chunks after timeout", async t => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const warnings = t.mock.method(console, "warn", () => {});
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const pending: Array<{ cx: number; cz: number; resolve(bytes: Uint8Array): void }> = [];
	f.context.exports = { ChunkGen: {
		generate(_seed, _generator, cx, cz) {
			return new Promise<Uint8Array>(resolve => pending.push({ cx, cz, resolve }));
		},
	} };
	await f.join("dev:player");
	const core = f.world.core;
	const mode = t.mock.method(core, "setExternalGeneration");
	const client = new ClientCore(new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url))), {}));
	core.packet(1, client.encodeHello(2));
	const socket = f.world.sockets.get(1);
	let consumed = 0;
	const step = () => {
		f.world.step();
		for (const data of socket.sent.slice(consumed)) if (typeof data !== "string") client.packet(data);
		consumed = socket.sent.length;
	};
	step();
	assert.equal(pending.length, 8);
	assert.equal(client.chunkCount, 0);
	now = 5000;
	step();
	assert.equal(f.world.generation.failed, true);
	assert.equal(f.world.generationFailed, true);
	assert.ok(mode.mock.calls.some(call => call.arguments[0] === 0));
	assert.equal(f.world.metrics().generation.fallback, 8);
	assert.ok(client.chunkCount > 0, "timed-out chunks stream synchronously in the same tick");
	const gen = ChunkGenCore.fromModule(storageModule);
	for (const request of pending) request.resolve(gen.generate(2026n, Generator.Flat, request.cx, request.cz));
	await new Promise(resolve => setImmediate(resolve));
	for (let i = 0; i < 10; i++) step();
	assert.equal(pending.length, 8, "no RPCs issued after timeout");
	assert.equal(f.world.metrics().generation.delivered, 0);
	assert.equal(warnings.mock.callCount(), 1);
});

test("DO decodes display names and sends presence and messages through the WASM codecs", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const core = f.world.ensureCore();
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const chat = () => core.takeOutbox().flatMap(({ client: id, data }) =>
		client.packet(data) === S2C.Chat ? [{ id, line: client.takeChat() }] : [],
	);
	const sender = "\ufeff空 🙂 %";
	assert.equal((await f.join("first", undefined, undefined, encodeURIComponent(sender))).status, 101);
	assert.equal((await f.join("second", undefined, undefined, "%FF")).status, 101);
	core.packet(1, client.encodeHello(2));
	core.packet(2, client.encodeHello(2));
	core.tick();
	assert.deepEqual(chat(), [{ id: 1, line: { kind: 1, sender: "プレイヤー", text: "" } }]);

	const text = "🙂".repeat(256);
	f.world.sockets.get(1).dispatchEvent(new MessageEvent("message", { data: client.encodeChat(text).buffer }));
	core.tick();
	assert.deepEqual(chat(), [1, 2].map(id => ({ id, line: { kind: 0, sender, text } })));
	assert.equal(client.takeChat(), null);

	assert.equal(f.world.revoke("first"), 1);
	assert.deepEqual(chat(), [{ id: 2, line: { kind: 2, sender, text: "" } }]);
});

test("DO keeps each user's inventory across socket replacement", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const core = f.world.ensureCore();
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	assert.equal((await f.join("user")).status, 101);
	core.packet(1, client.encodeHello(2)); core.tick(); core.takeOutbox();
	core.packet(1, client.encodeCreativeSetSlot(0, 1, 23));
	core.packet(1, client.encodeSelectSlot(5)); core.tick();
	const saved = core.inventoryData(1)!;
	assert.equal((await f.join("user")).status, 101);
	assert.equal(core.inventoryData(1), undefined);
	assert.deepEqual(core.inventoryData(2), saved);
	assert.equal((await f.join("another-user")).status, 101);
	assert.notDeepEqual(core.inventoryData(3), saved);
});

test("DO eviction saves animals and dropped items and the recreated world streams them", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.env.GEN_OFFLOAD = "0";
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	f.world.lastAccessCheck = Date.now();
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const join = async () => {
		assert.equal((await f.join("player")).status, 101);
		const [id, socket] = [...f.world.sockets.entries()][0];
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		f.world.core.packet(id, client.encodeHello(4));
		let consumed = 0;
		const step = () => {
			f.world.step();
			for (const data of socket.sent.slice(consumed)) if (typeof data !== "string") client.packet(data);
			consumed = socket.sent.length;
		};
		return { id, client, step, core: f.world.core };
	};
	const before = await join();
	for (let i = 0; i < 20; i++) before.step();
	before.core.setTime(399n, 6000n);
	before.step();
	const chunksAtAutosave = f.sqlite.prepare("SELECT count(*) AS n FROM chunks").get().n;
	assert.ok(chunksAtAutosave > 0, "the scheduled save includes newly spawned animals");
	const item = before.client.inventory[0]!.item;
	before.core.packet(before.id, before.client.encodeDropItem([1, 0, 0]));
	before.step();
	const animal = before.client.mobs[0];
	assert.ok(animal);
	assert.deepEqual(before.client.entities.map(({ item, count }) => [item, count]), [[item, 1]]);
	assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM chunks").get().n, chunksAtAutosave);
	assert.ok(before.core.dirtyChunks > 0, "the dropped item is pending before eviction");

	f.world.evict();
	assert.ok(f.sqlite.prepare("SELECT count(*) AS n FROM chunks").get().n > chunksAtAutosave);
	const restored = await join();
	for (let i = 0; i < 20; i++) restored.step();
	assert.ok(restored.client.mobs.some(mob => mob.kind === animal.kind
		&& Math.hypot(mob.position[0] - animal.position[0], mob.position[2] - animal.position[2]) <= 2));
	assert.deepEqual(restored.client.entities.map(({ item, count }) => [item, count]), [[item, 1]]);
});

test("DO reads pending animals and drops ahead of SQLite after a transaction rolls back", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.env.GEN_OFFLOAD = "0";
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	f.world.lastAccessCheck = Date.now();
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const join = async () => {
		assert.equal((await f.join("dev:player")).status, 101);
		const [id, socket] = [...f.world.sockets.entries()][0];
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		const core = f.world.core;
		core.packet(id, client.encodeHello(4));
		let consumed = 0;
		const step = () => {
			f.world.step();
			for (const data of socket.sent.slice(consumed)) if (typeof data !== "string") client.packet(data);
			consumed = socket.sent.length;
		};
		return { id, client, core, step };
	};
	const before = await join();
	for (let i = 0; i < 20; i++) before.step();
	before.core.setTime(399n, 6000n);
	before.step();
	const animal = before.client.mobs[0];
	assert.ok(animal);
	const [x, y, z] = animal.position;
	const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
	const inChunk = ({ position: [x, , z] }) => Math.floor(x / 16) === cx && Math.floor(z / 16) === cz;
	const readRow = () => f.sqlite.prepare("SELECT data FROM chunks WHERE cx = ? AND cz = ?").get(cx, cz).data;
	const stored = readRow();

	// Drop into the animal's chunk, which currently has a stale row in SQLite.
	const item = before.client.inventory[0]!.item;
	before.core.packet(before.id, before.client.encodeTeleport(cx * 16 + 8.5, y, cz * 16 + 8.5));
	before.core.packet(before.id, before.client.encodeDropItem([0, 0, 0]));
	before.step();
	assert.ok(before.client.mobs.some(inChunk));
	assert.ok(before.client.entities.some(drop => inChunk(drop) && drop.item === item && drop.count === 1));
	const gameTime = before.core.gameTime;
	const dayTime = before.core.dayTime;

	const warn = t.mock.method(console, "warn", () => {});
	const sql = f.context.storage.sql;
	const exec = sql.exec.bind(sql);
	const failure = t.mock.method(sql, "exec", (query, ...args) => {
		const result = exec(query, ...args);
		if (query.startsWith("INSERT INTO chunks")) throw new Error("write rolled back");
		return result;
	});
	f.world.evict();
	failure.mock.restore();
	assert.equal(warn.mock.callCount(), 1);
	assert.deepEqual(readRow(), stored);
	assert.equal(f.world.core, null);

	const after = await join();
	assert.equal(after.core.gameTime, gameTime);
	assert.equal(after.core.dayTime, dayTime);
	for (let i = 0; i < 20; i++) after.step();
	assert.ok(after.client.mobs.some(mob => inChunk(mob) && mob.kind === animal.kind));
	assert.ok(after.client.entities.some(drop => inChunk(drop) && drop.item === item && drop.count === 1));
	assert.deepEqual(readRow(), stored, "reading a pending snapshot does not commit it");
	assert.ok(f.world.save(false) > 0);
	assert.notDeepEqual(readRow(), stored);
	assert.equal(f.world.save(false), 0);
	assert.equal(warn.mock.callCount(), 1);
});

test("DO restores the saved mode and persists creative for a missing gamemode", t => {
	for (const gameMode of [undefined, "survival"] as const) {
		const f = fixture(t);
		delete f.world.ensureCore;
		f.world.setMeta("seed", "2026"); f.world.setMeta("generator", String(Generator.Flat));
		if (gameMode) f.world.setMeta("gamemode", gameMode);
		const core = f.world.ensureCore();
		const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
		const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
		core.connect(1); core.packet(1, client.encodeHello(2)); core.tick();
		for (const { data } of core.takeOutbox()) client.packet(data);
		assert.equal(client.gameMode, gameMode ?? "creative");
		assert.equal(f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode'").get()?.value, gameMode ?? "creative");
		if (gameMode === "survival") assert.deepEqual(client.inventory, Array(36).fill(null));
	}
});

test("DO game mode RPC persists and only restarts connections on a change", async t => {
	const f = fixture(t, true);
	const revision = () => f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode_revision'").get()?.value;
	assert.equal(f.world.getGameMode(), "creative");
	await f.world.setGameMode("survival");
	assert.equal(f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode'").get()?.value, "survival");
	assert.equal(revision(), "1");
	await f.join("first");
	await f.join("second");
	await f.world.setGameMode("survival");
	assert.equal(revision(), "2");
	assert.deepEqual(f.closed, []);
	await f.world.setGameMode("creative");
	assert.equal(f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode'").get()?.value, "creative");
	assert.equal(revision(), "3");
	assert.deepEqual(f.closed, Array.from({ length: 2 }, () => [SERVICE_RESTART, "ゲームモードが変わりました"]));
	assert.deepEqual(f.disconnected, [1, 2]);
});

test("DO applies the mode header before admitting the new socket and retains player state", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.env.GEN_OFFLOAD = "0";
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	await f.join("first");
	await f.join("second");
	const core = f.world.ensureCore();
	const welcome = (id: number) => {
		core.packet(id, client.encodeHello(2));
		core.tick();
		for (const packet of core.takeOutbox()) if (packet.client === id) client.packet(packet.data);
		return client.gameMode;
	};
	assert.equal(welcome(1), "creative");
	core.packet(1, client.encodeCreativeSetSlot(0, 1, 23));
	core.tick();
	const saved = core.inventoryData(1);
	assert.ok(saved);

	assert.equal((await f.join("first", undefined, undefined, undefined, "survival", "1")).status, 101);
	assert.equal(f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode'").get()?.value, "survival");
	assert.deepEqual([...f.world.sockets.keys()], [3]);
	assert.deepEqual(f.closed, Array.from({ length: 2 }, () => [SERVICE_RESTART, "ゲームモードが変わりました"]));
	assert.deepEqual(core.inventoryData(3), saved);
	assert.equal(welcome(3), "survival");

	await f.join("third", undefined, undefined, undefined, "survival", "1");
	await f.join("fourth");
	assert.equal(f.closed.length, 2);
	assert.deepEqual([...f.world.sockets.keys()], [3, 4, 5]);
	assert.equal(welcome(5), "survival");
});

test("DO ignores a stale or equal game mode revision and applies a newer join", async t => {
	const f = fixture(t);
	delete f.world.ensureCore;
	f.world.env.GEN_OFFLOAD = "0";
	f.world.setMeta("seed", "2026");
	f.world.setMeta("generator", String(Generator.Flat));
	const clientModule = new WebAssembly.Module(readFileSync(new URL("../wasm/client.wasm", import.meta.url)));
	const client = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const mode = () => f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode'").get()?.value;
	const revision = () => f.sqlite.prepare("SELECT value FROM meta WHERE key = 'gamemode_revision'").get()?.value;
	const welcome = (id: number) => {
		const core = f.world.ensureCore();
		core.packet(id, client.encodeHello(2));
		core.tick();
		for (const packet of core.takeOutbox()) if (packet.client === id) client.packet(packet.data);
		return client.gameMode;
	};

	await f.world.setGameMode("survival", 1);
	await f.world.setGameMode("creative", 1);
	assert.equal(f.world.getGameMode(), "survival");
	assert.equal(mode(), "survival");
	assert.equal(revision(), "1");

	assert.equal((await f.join("late", undefined, undefined, undefined, "creative", "0")).status, 101);
	assert.equal(f.world.getGameMode(), "survival");
	assert.equal(mode(), "survival");
	assert.equal(revision(), "1");
	assert.equal(welcome(1), "survival");
	assert.deepEqual(f.closed, []);

	await f.join("same", undefined, undefined, undefined, "creative", "1");
	assert.equal(f.world.getGameMode(), "survival");
	assert.equal(revision(), "1");
	assert.deepEqual(f.closed, []);
	assert.equal(welcome(2), "survival");

	await f.join("ignored", undefined, undefined, undefined, "creative", "nope");
	await f.join("missing", undefined, undefined, undefined, "creative");
	assert.equal(f.world.getGameMode(), "survival");
	assert.equal(revision(), "1");
	assert.equal(welcome(4), "survival");
	assert.deepEqual(f.closed, []);

	assert.equal((await f.join("newer", undefined, undefined, undefined, "creative", "2")).status, 101);
	assert.equal(f.world.getGameMode(), "creative");
	assert.equal(mode(), "creative");
	assert.equal(revision(), "2");
	assert.deepEqual(f.closed, Array.from({ length: 4 }, () => [SERVICE_RESTART, "ゲームモードが変わりました"]));
	assert.deepEqual([...f.world.sockets.keys()], [5]);
	assert.equal(welcome(5), "creative");
});
