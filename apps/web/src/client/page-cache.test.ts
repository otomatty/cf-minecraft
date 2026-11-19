import assert from "node:assert/strict";
import { test } from "node:test";
import { pageCacheActions } from "./page-cache.ts";

test("bfcache actions follow persistence and single-player versus multiplayer", () => {
	assert.deepEqual(pageCacheActions("pagehide", false, "local", { persistence: "opfs" }), ["flush"]);
	assert.deepEqual(pageCacheActions("pagehide", false, "websocket"), ["flush"]);
	assert.deepEqual(pageCacheActions("pagehide", true, "local", { persistence: "opfs" }), ["flush", "close"]);
	assert.deepEqual(pageCacheActions("pagehide", true, "websocket"), ["flush"]);
	assert.deepEqual(pageCacheActions("pageshow", false, "local", { closedOnHide: true }), []);
	assert.deepEqual(pageCacheActions("pageshow", false, "websocket"), []);
	assert.deepEqual(pageCacheActions("pageshow", true, "local", { closedOnHide: true }), ["reload"]);
	assert.deepEqual(pageCacheActions("pageshow", true, "websocket"), ["resume"]);
});

test("a single-player worker with persistence off stays alive in the back-forward cache", () => {
	assert.deepEqual(pageCacheActions("pagehide", true, "local", { persistence: "off" }), ["flush"]);
	assert.deepEqual(pageCacheActions("pageshow", true, "local", { closedOnHide: false }), []);
});

test("a single-player worker can hold OPFS handles before ready", () => {
	assert.deepEqual(pageCacheActions("pagehide", true, "local"), ["flush", "close"]);
});
