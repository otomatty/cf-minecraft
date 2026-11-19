import assert from "node:assert/strict";
import { test } from "node:test";
import { pageCacheActions } from "./page-cache.ts";

test("bfcache actions follow persistence and single-player versus multiplayer", () => {
	assert.deepEqual(pageCacheActions("pagehide", false, "local"), ["flush"]);
	assert.deepEqual(pageCacheActions("pagehide", false, "websocket"), ["flush"]);
	assert.deepEqual(pageCacheActions("pagehide", true, "local"), ["flush", "close"]);
	assert.deepEqual(pageCacheActions("pagehide", true, "websocket"), ["flush"]);
	assert.deepEqual(pageCacheActions("pageshow", false, "local"), []);
	assert.deepEqual(pageCacheActions("pageshow", false, "websocket"), []);
	assert.deepEqual(pageCacheActions("pageshow", true, "local"), ["reload"]);
	assert.deepEqual(pageCacheActions("pageshow", true, "websocket"), ["resume"]);
});
