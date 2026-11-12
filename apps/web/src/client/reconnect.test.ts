import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDelayMs, shouldReconnect } from "./reconnect.ts";
import { WebSocketTransport } from "./transport.ts";

test("backoff doubles from 500 ms and stays capped without an attempt limit", () => {
	assert.deepEqual(Array.from({ length: 7 }, (_, i) => nextDelayMs(i, () => 1)),
		[500, 1000, 2000, 4000, 8000, 10000, 10000]);
	assert.equal(nextDelayMs(100000, () => 1), 10000);
});

test("jitter stays between half and all of each capped delay", () => {
	for (const attempt of [0, 1, 4, 5, 100000]) {
		const base = Math.min(10000, 500 * 2 ** Math.min(attempt, 5));
		assert.equal(nextDelayMs(attempt, () => 0), base / 2);
		assert.equal(nextDelayMs(attempt, () => 1), base);
		for (const random of [0.1, 0.5, 0.999]) {
			const delay = nextDelayMs(attempt, () => random);
			assert.ok(delay >= base / 2 && delay <= base);
		}
	}
});

test("only permanent application failures prevent reconnection", () => {
	for (const code of [4000, 4001, 4002, 4003]) assert.equal(shouldReconnect(code), false);
	for (const code of [1000, 1003, 1006, 1008, 1011, 1012, 1013, 4999]) assert.equal(shouldReconnect(code), true);
});

function fixture(t) {
	const sockets = [];
	class Socket {
		static OPEN = 1;
		readyState = 0;
		sent = [];
		constructor(url) { this.url = url; sockets.push(this); }
		send(packet) { this.sent.push(packet); }
		close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
		open() { this.readyState = 1; this.onopen(); }
		drop(code = 1012) { this.readyState = 3; this.onclose({ code, reason: "dropped" }); }
		packet(data) { this.onmessage({ data: new Uint8Array(data).buffer }); }
	}
	for (const [key, value] of Object.entries({ WebSocket: Socket, location: { protocol: "https:", host: "game.example" } })) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		t.after(() => {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		});
	}
	const timers = [];
	t.mock.method(globalThis, "setTimeout", (callback, delay) => {
		const timer = { callback, delay, cleared: false };
		timers.push(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearTimeout", timer => { timer.cleared = true; });
	t.mock.method(Math, "random", () => 1);
	let status = 200;
	let reject = false;
	const requests = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		requests.push({ url, options });
		if (reject) throw new Error("offline");
		return { status };
	});
	const retrying = [];
	const closed = [];
	let opens = 0;
	const transport = new WebSocketTransport("my-world", {
		onOpen: () => { opens++; },
		onPacket: () => {},
		onStats: () => {},
		onReconnecting: info => retrying.push(info),
		onClose: (reason, code) => closed.push({ reason, code }),
	});
	t.after(() => transport.close());
	return {
		transport, sockets, timers, requests, retrying, closed, opens: () => opens,
		status: value => { status = value; },
		reject: value => { reject = value; },
		async advance() {
			const timer = timers.shift();
			assert.ok(timer && !timer.cleared);
			timer.callback();
			await new Promise(resolve => queueMicrotask(resolve));
		},
	};
}

test("transport probes before retry, resets attempts only on Welcome, and drops disconnected sends", async t => {
	const f = fixture(t);
	f.transport.send(new Uint8Array([1]));
	assert.deepEqual(f.sockets[0].sent, []);
	f.sockets[0].open();
	f.sockets[0].packet([0]); // Welcome
	f.sockets[0].drop();
	assert.deepEqual(f.retrying[0], { attempt: 1, delayMs: 500, reason: "dropped" });
	await f.advance();
	assert.equal(f.requests[0].url, "/api/worlds/my-world");
	assert.equal(f.sockets.length, 2);
	f.sockets[1].open();
	f.sockets[1].drop(); // Open alone must not reset the attempt count.
	assert.equal(f.retrying[1].delayMs, 1000);
	await f.advance();
	f.sockets[2].open();
	f.sockets[2].packet([0]);
	f.transport.send(new Uint8Array([1]));
	assert.equal(f.sockets[2].sent.length, 1);
	f.sockets[2].drop();
	assert.equal(f.retrying[2].delayMs, 500);
	assert.equal(f.opens(), 3);
	assert.deepEqual(f.closed, []);
});

for (const [status, reason] of [[401, "ログインし直してください"], [403, "このワールドに招待されていません"], [404, "ワールドがありません"]]) {
	test(`transport stops on access check ${status}`, async t => {
		const f = fixture(t);
		f.status(status);
		f.sockets[0].drop();
		await f.advance();
		assert.deepEqual(f.closed, [{ reason, code: undefined }]);
		assert.equal(f.sockets.length, 1);
		assert.equal(f.timers.length, 0);
	});
}

test("transient HTTP and network failures keep retrying", async t => {
	const f = fixture(t);
	f.status(503);
	f.sockets[0].drop();
	await f.advance();
	assert.equal(f.sockets.length, 1);
	f.reject(true);
	await f.advance();
	assert.deepEqual(f.retrying.map(info => info.delayMs), [500, 1000, 2000]);
	f.reject(false);
	f.status(200);
	await f.advance();
	assert.equal(f.sockets.length, 2);
});

test("permanent close codes terminate without probing", t => {
	const f = fixture(t);
	f.sockets[0].drop(4000);
	assert.deepEqual(f.closed, [{ reason: "dropped", code: 4000 }]);
	assert.equal(f.requests.length, 0);
	assert.equal(f.timers.length, 0);
});

test("explicit close cancels a scheduled retry", t => {
	const f = fixture(t);
	f.sockets[0].drop();
	f.transport.close();
	assert.equal(f.timers[0].cleared, true);
	assert.deepEqual(f.closed, []);
});

test("explicit close during a probe prevents a late connection", async t => {
	const f = fixture(t);
	let resolve;
	t.mock.method(globalThis, "fetch", () => new Promise(done => { resolve = done; }));
	f.sockets[0].drop();
	await f.advance();
	f.transport.close();
	resolve({ status: 200 });
	await new Promise(done => queueMicrotask(done));
	assert.equal(f.sockets.length, 1);
	assert.equal(f.timers.length, 0);
	assert.deepEqual(f.closed, []);
});
