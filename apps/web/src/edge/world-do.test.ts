import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

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
	const world = new WorldDO({ storage: { sql: { exec() {} } } }, {});
	world.ensureCore = () => ({
		connect(id) {
			connected.push(id);
		},
		disconnect(id) {
			disconnected.push(id);
		},
	});
	world.startTicking = () => {};
	const join = (user?: string) =>
		world.fetch(
			new Request("https://game.example/ws/lobby", {
				headers: { Upgrade: "websocket", ...(user ? { "X-MC-User": user } : {}) },
			}),
		);
	return { world, join, connected, disconnected, closed };
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
