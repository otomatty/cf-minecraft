import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmSaved, finishWorldImport } from "./world-import.ts";

const request = { id: 7, world: "imported-world" };

test("confirmSaved waits until saving finishes and checks the final persistence state", async () => {
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const persistence = { retrying: true };
	let finished = false;
	const saving = confirmSaved(async () => {
		await blocked;
		persistence.retrying = false;
	}, persistence).then(() => { finished = true; });
	await Promise.resolve();
	assert.equal(finished, false);
	release();
	await saving;
	assert.equal(finished, true);
});

test("confirmSaved blocks returning to the title when persistence is retrying", async () => {
	await assert.rejects(confirmSaved(async () => {}, { retrying: true }), {
		message: "ワールドの保存に失敗したため、タイトルに戻れません。もう一度お試しください",
	});
});

test("confirmSaved preserves the cause when saving rejects", async () => {
	const cause = new Error("I/O failure");
	await assert.rejects(confirmSaved(async () => { throw cause; }, { retrying: false }), {
		message: "ワールドの保存に失敗したため、タイトルに戻れません。もう一度お試しください",
		cause,
	});
});

test("imported is sent only after the current world finishes saving", async () => {
	const events: unknown[] = [];
	let release!: () => void;
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const persistence = { retrying: true };
	const finished = finishWorldImport(request, async () => {
		events.push("saving");
		await blocked;
		persistence.retrying = false;
		events.push("saved");
	}, persistence, event => { events.push(event); });
	assert.deepEqual(events, ["saving"]);
	release();
	await finished;
	assert.deepEqual(events, ["saving", "saved", { type: "imported", ...request }]);
});

test("persistent save failures never send imported and identify the completed destination", async () => {
	const events: unknown[] = [];
	let saves = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(finishWorldImport(request, async () => { saves++; }, { retrying: true }, event => { events.push(event); }), {
			message: "今のワールドの保存に失敗したため、移動できません。もう一度お試しください。読み込んだワールドは imported-world にあります",
		});
	}
	assert.equal(saves, 2);
	assert.deepEqual(events, []);
});

test("a rejected save also blocks imported and reports the destination", async () => {
	const events: unknown[] = [];
	const cause = new Error("I/O failure");
	await assert.rejects(finishWorldImport(request, async () => { throw cause; }, { retrying: false }, event => { events.push(event); }), {
		message: "今のワールドの保存に失敗したため、移動できません。もう一度お試しください。読み込んだワールドは imported-world にあります",
		cause,
	});
	assert.deepEqual(events, []);
});
