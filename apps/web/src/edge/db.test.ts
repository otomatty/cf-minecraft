import assert from "node:assert/strict";
import { test } from "node:test";
import { createDB, MAX_MEMBERS_PER_WORLD, MAX_WORLDS_PER_CREATOR } from "./db.ts";
import { testDB } from "./d1-shim.test.ts";

test("migration, atomic creation, membership queries, and world quota", async t => {
	const fixture = testDB();
	t.after(fixture.close);
	fixture.user("owner", "owner@example.com");
	const db = createDB(fixture.db);
	for (let i = 0; i < MAX_WORLDS_PER_CREATOR; i++) {
		assert.equal(await db.createWorld(`world-${i}`, "owner", "owner@example.com"), "created");
	}
	assert.equal(await db.createWorld("extra", "owner", "owner@example.com"), "limit");
	assert.equal(await db.world("extra"), null);
	assert.equal((await db.worlds("owner", "owner@example.com")).length, 5);
	assert.deepEqual(await db.member("world-0", "owner@example.com"), { role: "operator" });
	assert.equal((await db.world("world-0"))?.owner_email, "owner@example.com");
});

test("duplicate creation is rolled back and foreign keys cascade", async t => {
	const f = testDB();
	t.after(f.close);
	f.user("o", "o@example.com");
	f.user("p", "p@example.com");
	const db = createDB(f.db);
	assert.equal(await db.createWorld("lobby", "o", "o@example.com"), "created");
	assert.equal(await db.createWorld("lobby", "p", "p@example.com"), "exists");
	assert.equal(await db.member("lobby", "p@example.com"), null);
	f.sqlite.prepare('DELETE FROM "user" WHERE id = ?').run("o");
	assert.equal(await db.world("lobby"), null);
	assert.deepEqual(await db.members("lobby"), []);
});

test("member cap permits updates, and deletion releases a slot", async t => {
	const f = testDB();
	t.after(f.close);
	f.user("o", "o@example.com");
	const db = createDB(f.db);
	await db.createWorld("lobby", "o", "o@example.com");
	for (let i = 1; i < MAX_MEMBERS_PER_WORLD; i++) {
		assert.equal(await db.putMember("lobby", `p${i}@example.com`, "player"), true);
	}
	assert.equal(await db.putMember("lobby", "extra@example.com", "player"), false);
	assert.equal(await db.putMember("lobby", "p1@example.com", "operator"), true);
	await db.deleteMember("lobby", "p1@example.com");
	assert.equal(await db.putMember("lobby", "extra@example.com", "player"), true);
});
