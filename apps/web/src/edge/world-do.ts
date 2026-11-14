import { DurableObject } from "cloudflare:workers";

import {
	LOGGED_IN_ELSEWHERE, ACCESS_REVOKED, TOO_MANY_PACKETS, BAD_PACKET, WORLD_FULL, SERVICE_RESTART,
} from "../shared/close-codes.ts";
import { RegionCodec } from "../shared/region-codec.ts";
import { Generator, ServerCore } from "../shared/server-core.ts";
import { summarize, TICK_MS, TickPacer } from "../shared/tick-pacer.ts";
import serverWasm from "../wasm/server.wasm";

// One world = one Durable Object: the dedicated server.
//
// While players are connected the object stays in memory and runs the core at
// 20 ticks per second from a timer. All game state lives in the WebAssembly
// instance; SQLite holds what must survive: edited chunks and the clock.
//
// Durability: edits are written by an autosave every AUTOSAVE_TICKS, and when
// the last player leaves. If the object is evicted or redeployed in between,
// at most that window of edits is lost and players reconnect. (The game itself
// autosaves every five minutes.)

const MAX_PLAYERS = 16;
const MAX_PACKET_BYTES = 256;
/** Packets accepted per client per tick before the connection is dropped. */
const MAX_PACKETS_PER_TICK = 100;
const AUTOSAVE_TICKS = 100;
/** Ticks without any player before the loop stops and the object may sleep. */
const IDLE_STOP_TICKS = 100;
// Bound how long an in-flight authorization can admit a connection.
const AUTHORIZATION_MAX_AGE_MS = 30_000;
// Allow for clock differences between the Worker and Durable Object hosts.
const CLOCK_SKEW_MS = 2_000;
/** Recheck connected Better Auth sessions and membership every minute. */
const ACCESS_RECHECK_MS = 60_000;

export interface WorldMetrics {
	ticking: boolean;
	seed: string | null;
	gameTime: number;
	players: number;
	loadedChunks: number;
	storedChunks: number;
	wasmMemoryBytes: number;
	ticksRun: number;
	ticksSkipped: number;
	/** Achieved ticks per second over the sampled window. */
	tps: number;
	/** Wall-clock gap between timer callbacks. */
	timerGap: ReturnType<typeof summarize>;
}

export class WorldDO extends DurableObject<Env> {
	private core: ServerCore | null = null;
	private codec: RegionCodec | null = null;
	private seed: bigint | null = null;
	private readonly sockets = new Map<number, WebSocket>();
	private readonly users = new Map<number, string>();
	private readonly sessions = new Map<number, string>();
	private worldName: string | null = null;
	private lastAccessCheck = Date.now();
	private accessCheckRunning = false;
	private readonly packetCounts = new Map<number, number>();
	private nextClient = 1;
	private timer: ReturnType<typeof setInterval> | null = null;
	private pacer: TickPacer | null = null;
	private idleTicks = 0;
	private lastMetrics: Pick<WorldMetrics, "ticksRun" | "ticksSkipped" | "tps" | "timerGap"> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Synchronous SQLite: no awaits, so no request can interleave with setup.
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				cx INTEGER NOT NULL,
				cz INTEGER NOT NULL,
				data BLOB NOT NULL,
				format INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (cx, cz)
			) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS revocations (
				user_id TEXT PRIMARY KEY,
				at INTEGER NOT NULL
			) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			) WITHOUT ROWID;
		`);
		const columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(chunks)").toArray();
		if (!columns.some((column) => column.name === "format")) {
			ctx.storage.sql.exec("ALTER TABLE chunks ADD COLUMN format INTEGER NOT NULL DEFAULT 0");
		}
	}

	private meta(key: string): string | null {
		const rows = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
		return rows.length > 0 ? rows[0].value : null;
	}

	private setMeta(key: string, value: string): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	private ensureCore(): ServerCore {
		if (this.core) return this.core;
		let seedText = this.meta("seed");
		if (seedText === null) {
			// The host chooses the seed; from here on the core is deterministic.
			seedText = crypto.getRandomValues(new BigInt64Array(1))[0].toString();
			this.setMeta("seed", seedText);
		}
		this.seed = BigInt(seedText);
		const instance = new WebAssembly.Instance(serverWasm, {});
		const core = new ServerCore(instance);
		this.codec = new RegionCodec(instance);
		core.start(this.seed, Generator.DebugHills);
		core.setTime(BigInt(this.meta("gameTime") ?? "0"), BigInt(this.meta("dayTime") ?? "0"));
		const stored = this.ctx.storage.sql.exec<{ cx: number; cz: number }>("SELECT cx, cz FROM chunks").toArray();
		core.setStored(stored.map((r) => [r.cx, r.cz] as const));
		this.core = core;
		return core;
	}

	override async fetch(request: Request): Promise<Response> {
		const user = request.headers.get("X-MC-User");
		if (!user) return new Response("Forbidden", { status: 403 });
		const authorization = request.headers.get("X-MC-Authorized-At");
		const authorizedAt = Number(authorization);
		if (
			authorization === null ||
			!/^-?\d+$/.test(authorization) ||
			!Number.isSafeInteger(authorizedAt) ||
			Date.now() - authorizedAt > AUTHORIZATION_MAX_AGE_MS
		) {
			return new Response("Forbidden", { status: 403 });
		}
		const revocations = this.ctx.storage.sql.exec<{ at: number }>(
			"SELECT at FROM revocations WHERE user_id = ?",
			user,
		).toArray();
		if (revocations.length > 0 && authorizedAt <= revocations[0].at + CLOCK_SKEW_MS) {
			return new Response("Forbidden", { status: 403 });
		}
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const previous = [...this.users].find(([, identity]) => identity === user)?.[0];
		if (this.sockets.size - (previous === undefined ? 0 : 1) >= MAX_PLAYERS) {
			const pair = new WebSocketPair();
			pair[1].accept();
			pair[1].close(WORLD_FULL, "world is full");
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		const core = this.ensureCore();
		if (previous !== undefined) {
			this.sockets.get(previous)?.close(LOGGED_IN_ELSEWHERE, "logged in elsewhere");
			if (this.sockets.delete(previous)) {
				this.users.delete(previous);
				this.sessions.delete(previous);
				this.packetCounts.delete(previous);
				core.disconnect(previous);
			}
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		// A plain accept(), not the hibernation API: the tick loop needs the
		// object in memory for as long as anyone is connected.
		server.accept();
		// Newer compatibility dates deliver binary frames as Blobs unless told otherwise.
		server.binaryType = "arraybuffer";

		const id = this.nextClient++;
		core.connect(id);
		this.sockets.set(id, server);
		this.users.set(id, user);
		const session = request.headers.get("X-MC-Session");
		if (session) this.sessions.set(id, session);
		// The router forwards /ws/:world to its named DO.
		this.worldName = new URL(request.url).pathname.split("/").filter(Boolean)[1];

		const drop = () => {
			if (this.sockets.delete(id)) {
				this.users.delete(id);
				this.sessions.delete(id);
				this.packetCounts.delete(id);
				core.disconnect(id);
			}
		};
		server.addEventListener("message", (event) => {
			if (!this.sockets.has(id)) return;
			const data = event.data;
			if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_PACKET_BYTES) {
				server.close(BAD_PACKET, "binary packets only");
				drop();
				return;
			}
			const count = (this.packetCounts.get(id) ?? 0) + 1;
			this.packetCounts.set(id, count);
			if (count > MAX_PACKETS_PER_TICK) {
				server.close(TOO_MANY_PACKETS, "too many packets");
				drop();
				return;
			}
			core.packet(id, new Uint8Array(data));
		});
		server.addEventListener("close", drop);
		server.addEventListener("error", drop);

		this.startTicking();
		return new Response(null, { status: 101, webSocket: client });
	}

	revoke(userId: string): number {
		const now = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT INTO revocations (user_id, at) VALUES (?, ?) " +
				"ON CONFLICT(user_id) DO UPDATE SET at = excluded.at",
			userId,
			now,
		);
		this.ctx.storage.sql.exec(
			"DELETE FROM revocations WHERE at < ?",
			now - AUTHORIZATION_MAX_AGE_MS - CLOCK_SKEW_MS,
		);
		let revoked = 0;
		for (const [id, user] of this.users) {
			if (user !== userId) continue;
			const core = this.ensureCore();
			this.sockets.get(id)?.close(ACCESS_REVOKED, "access revoked");
			if (this.sockets.delete(id)) {
				this.users.delete(id);
				this.sessions.delete(id);
				this.packetCounts.delete(id);
				core.disconnect(id);
			}
			revoked++;
		}
		return revoked;
	}

	/** RPC (debug): disconnect everyone using the same cleanup as revoke. */
	disconnectAll(code: number, reason: string): number {
		const count = this.sockets.size;
		for (const [id, socket] of this.sockets) {
			socket.close(code, reason);
			if (this.sockets.delete(id)) {
				this.users.delete(id);
				this.sessions.delete(id);
				this.packetCounts.delete(id);
				this.ensureCore().disconnect(id);
			}
		}
		return count;
	}

	/** RPC (debug): force the next connection to restore the core from SQLite. */
	evict(): void {
		this.disconnectAll(SERVICE_RESTART, "debug evict");
		this.save();
		this.stopTicking();
		this.core = null;
		this.codec = null;
		this.seed = null;
		this.idleTicks = 0;
		this.lastMetrics = null;
	}

	private async recheckAccess(): Promise<void> {
		const connections = [...this.sessions].map(([id, session]) => ({
			id, session, user: this.users.get(id),
		}));
		if (connections.length === 0) return;
		try {
			// At most MAX_PLAYERS session IDs: one query, below D1's bind limit.
			// Better Auth's SQLite adapter stores dates as ISO 8601 strings.
			// Owners need membership too, exactly as at the router's entrance.
			const result = await this.env.DB.prepare(
				'SELECT s.id, s.userId, s.expiresAt FROM session s JOIN "user" u ON u.id = s.userId ' +
					"JOIN world_member m ON m.email = lower(u.email) " +
					"JOIN world w ON w.name = m.world " +
					`WHERE m.world = ? AND u.emailVerified = 1 AND s.id IN (${connections.map(() => "?").join(",")})`,
			).bind(this.worldName, ...connections.map(connection => connection.session))
				.all<{ id: string; userId: string; expiresAt: string }>();
			if (!result.success) throw new Error("Access recheck query failed");
			const now = Date.now();
			for (const connection of connections) {
				// An old query must never revoke a replacement connection.
				if (this.sessions.get(connection.id) !== connection.session) continue;
				if (result.results.some(row =>
					row.id === connection.session && row.userId === connection.user &&
					new Date(row.expiresAt).getTime() > now
				)) continue;
				this.sockets.get(connection.id)?.close(ACCESS_REVOKED, "access revoked");
				if (this.sockets.delete(connection.id)) {
					this.users.delete(connection.id);
					this.sessions.delete(connection.id);
					this.packetCounts.delete(connection.id);
					this.ensureCore().disconnect(connection.id);
				}
			}
		} catch (error) {
			console.error("access recheck failed", this.worldName, error);
		}
	}

	private startTicking(): void {
		this.idleTicks = 0;
		if (this.timer !== null) return;
		this.lastAccessCheck = Date.now();
		this.pacer = new TickPacer(Date.now());
		this.timer = setInterval(() => this.onTimer(), TICK_MS);
	}

	private stopTicking(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
		this.lastMetrics = this.loopMetrics();
		this.pacer = null;
	}

	private onTimer(): void {
		const pacer = this.pacer;
		if (!pacer) return;
		const due = pacer.due(Date.now());
		for (let i = 0; i < due; i++) this.step();
	}

	private step(): void {
		const core = this.core;
		if (!core) return;
		core.tick();
		const now = Date.now();
		if (!this.accessCheckRunning && now - this.lastAccessCheck >= ACCESS_RECHECK_MS) {
			this.lastAccessCheck = now;
			this.accessCheckRunning = true;
			void this.recheckAccess().finally(() => { this.accessCheckRunning = false; });
		}
		this.packetCounts.clear();

		for (const { client, data } of core.takeOutbox()) {
			const socket = this.sockets.get(client);
			if (!socket) continue;
			try {
				socket.send(data);
			} catch {
				// The peer went away; its close event cleans up.
			}
		}

		for (const [cx, cz] of core.takeRequests()) {
			const rows = this.ctx.storage.sql
				.exec<{ data: ArrayBuffer; format: number }>("SELECT data, format FROM chunks WHERE cx = ? AND cz = ?", cx, cz)
				.toArray();
			if (rows.length === 0) {
				core.chunkMissing(cx, cz);
				continue;
			}
			let data: Uint8Array = new Uint8Array(rows[0].data);
			if (rows[0].format !== 0) {
				try {
					if (rows[0].format !== 1) throw new Error("Unknown chunk format");
					data = this.codec!.call(3, data);
				} catch (error) {
					console.warn("Corrupt stored chunk", cx, cz, error);
					core.chunkMissing(cx, cz);
					continue;
				}
			}
			core.loadChunk(cx, cz, data);
		}

		if (core.gameTime % BigInt(AUTOSAVE_TICKS) === 0n) this.save();

		if (this.sockets.size === 0) {
			if (++this.idleTicks >= IDLE_STOP_TICKS) {
				this.save();
				this.stopTicking();
			}
		} else {
			this.idleTicks = 0;
		}
	}

	private save(): number {
		const core = this.core;
		if (!core) return 0;
		let saved = 0;
		// One transaction: a crash leaves either the old or the new snapshot.
		this.ctx.storage.transactionSync(() => {
			for (let chunk = core.takeDirty(); chunk !== null; chunk = core.takeDirty()) {
				const data = this.codec!.call(4, chunk.data);
				const blob = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
				this.ctx.storage.sql.exec(
					"INSERT INTO chunks (cx, cz, data, format) VALUES (?, ?, ?, 1) ON CONFLICT (cx, cz) DO UPDATE SET data = excluded.data, format = excluded.format",
					chunk.cx,
					chunk.cz,
					blob,
				);
				saved++;
			}
			this.setMeta("gameTime", core.gameTime.toString());
			this.setMeta("dayTime", core.dayTime.toString());
		});
		return saved;
	}

	private loopMetrics(): Pick<WorldMetrics, "ticksRun" | "ticksSkipped" | "tps" | "timerGap"> {
		const pacer = this.pacer;
		if (!pacer) return this.lastMetrics ?? { ticksRun: 0, ticksSkipped: 0, tps: 0, timerGap: summarize([]) };
		return {
			ticksRun: pacer.ticksRun,
			ticksSkipped: pacer.skipped,
			tps: pacer.measuredTps,
			timerGap: summarize(pacer.gaps),
		};
	}

	/** RPC: live numbers for the tick loop. */
	metrics(): WorldMetrics {
		const stored = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chunks").one().n;
		return {
			ticking: this.timer !== null,
			seed: this.seed?.toString() ?? this.meta("seed"),
			gameTime: Number(this.core?.gameTime ?? BigInt(this.meta("gameTime") ?? "0")),
			players: this.sockets.size,
			loadedChunks: this.core?.loadedChunks ?? 0,
			storedChunks: stored,
			wasmMemoryBytes: this.core?.memoryBytes ?? 0,
			...this.loopMetrics(),
		};
	}

	/** RPC (debug): the determinism scenario, run inside this runtime. */
	scenario(seed: string, ticks: number): { host: string; seed: string; ticks: number; hash: string } {
		const core = ServerCore.fromModule(serverWasm);
		return { host: "workerd-durable-object", seed, ticks, hash: core.runScenario(BigInt(seed), ticks) };
	}
}
