import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { arrowHitPosition, arrowStopped, blockSound, creeperIgnited, distanceGain, materialFor, MAX_VOICES,
	mobRemovalSound, playerSounds, soundGain, spatialSound, voicesToStop, type Sound } from "./events.ts";
import { GameAudio } from "./engine.ts";
import { playEffect } from "./effects.ts";
import { musicPlan } from "./music.ts";
import { WorldAudio } from "./world-audio.ts";
import { ClientCore, S2C, type ArrowEntity } from "../client-core.ts";
import type { Vec3 } from "../math.ts";

test("material follows the block name, including the current registry variants", () => {
	for (const [material, names] of Object.entries({
		stone: ["stone", "cobblestone_stairs", "sandstone", "iron_ore", "obsidian"],
		wood: ["oak_planks", "oak_log", "oak_slab", "oak_fence", "crafting_table"],
		earth: ["grass_block", "dirt", "coarse_dirt", "farmland"],
		sand: ["sand", "gravel", "snow_block"],
		glass: ["glass", "ice"],
		wool: ["white_wool"],
		plant: ["oak_leaves", "placed_oak_leaves", "red_flower", "short_grass", "wheat"],
		water: ["water", "flowing_water"],
		lava: ["lava", "flowing_lava"],
	})) {
		for (const name of names) assert.equal(materialFor(name), material, name);
	}
});

test("block sounds use the removed or placed material and ignore unloaded and flowing states", () => {
	assert.deepEqual(blockSound("oak_leaves", "air"), { kind: "break", material: "plant" });
	assert.deepEqual(blockSound("air", "oak_log"), { kind: "place", material: "wood" });
	assert.deepEqual(blockSound("water", "glass"), { kind: "place", material: "glass" });
	assert.deepEqual(blockSound("air", "lava"), { kind: "place", material: "lava" });
	assert.equal(blockSound("stone", "stone"), null);
	assert.equal(blockSound(undefined, "stone"), null);
	assert.equal(blockSound("air", "flowing_water"), null);
	assert.equal(blockSound("flowing_lava", "air"), null);
});

test("distance and both volume controls multiply and sources beyond 32 blocks are silent", () => {
	const volumes = { master: 80, effects: 50, music: 60 };
	assert.equal(soundGain(volumes, "effects", 0), 0.4);
	assert.equal(soundGain(volumes, "effects", 16), 0.2);
	assert.equal(soundGain(volumes, "music"), 0.48);
	assert.equal(soundGain({ ...volumes, music: 0 }, "music"), 0);
	assert.equal(soundGain({ ...volumes, master: 0 }, "effects"), 0);
	assert.ok(distanceGain(31.99) > 0);
	assert.equal(distanceGain(32), 0);
	assert.equal(soundGain(volumes, "effects", 40), 0);
	const camera = { x: 0, y: 0, z: 0, yaw: 0 };
	assert.deepEqual(spatialSound(camera, [-16, 0, 0]), { pan: 1, distance: 16 });
	assert.deepEqual(spatialSound(camera, [0, 32, 0]), { pan: 0, distance: 32 });
	assert.equal(spatialSound({ ...camera, yaw: 180 }, [-16, 0, 0]).pan, -1);
});

test("the oldest voice must be discarded before starting the 25th effect", () => {
	let active: number[] = [];
	for (let i = 0; i < 100; i++) {
		active = active.slice(voicesToStop(active.length));
		active.push(i);
		assert.ok(active.length <= 24);
	}
	assert.equal(MAX_VOICES, 24);
	assert.deepEqual(active, Array.from({ length: 24 }, (_, i) => i + 76));
	assert.equal(voicesToStop(23), 0);
	assert.equal(voicesToStop(24), 1);
});

test("fixed random inputs give reproducible music plans and the required sound and silence ranges", () => {
	for (const sample of [0, 0.33, 0.99999]) {
		const day = musicPlan(false, () => sample);
		const night = musicPlan(true, () => sample);
		assert.deepEqual(day, musicPlan(false, () => sample));
		assert.ok(night.beat > day.beat);
		for (const [plan, root, scale] of [[day, 55, [0, 2, 4, 7, 9]], [night, 48, [0, 3, 5, 7, 10]]] as const) {
			assert.ok(plan.duration >= 60 && plan.duration <= 180);
			assert.ok(plan.silence >= 120 && plan.silence <= 300);
			assert.ok(plan.notes.length > 0);
			assert.equal(plan.notes[0].at, 0);
			assert.ok(plan.notes.every((note, i) => note.at >= (plan.notes[i - 1]?.at ?? 0)
				&& note.at + note.duration < plan.duration
				&& scale.includes((note.midi - root + 12) % 12)));
		}
	}
});

test("vitals compare only the previous living state and emit the appropriate transitions", () => {
	const alive = { health: 14, food: 13, dead: false };
	const dead = { health: 0, food: 13, dead: true };
	assert.deepEqual(playerSounds(alive, { ...alive, food: 19 }), [{ kind: "eat" }]);
	assert.deepEqual(playerSounds(alive, dead), [{ kind: "playerHurt" }, { kind: "death" }]);
	assert.deepEqual(playerSounds(dead, { health: 20, food: 20, dead: false }), []);
});

test("creeper ignition and explosion are distinct from other mob removals", () => {
	assert.equal(creeperIgnited(0, 1), true);
	assert.equal(creeperIgnited(0, 18), false);
	assert.equal(creeperIgnited(1, 2), false);
	assert.deepEqual(mobRemovalSound({ kind: 6, fuse: 30 }, 30), { kind: "explosion" });
	assert.deepEqual(mobRemovalSound({ kind: 2, fuse: 0 }, 500), { kind: "mobDeath", mob: 2 });
	assert.equal(mobRemovalSound({ kind: 6, fuse: 10 }, Infinity), null);
});

test("arrow impacts infer embedding from the preserved vector and hits from the flight segment", () => {
	const arrow: ArrowEntity = { id: 1, position: [0, 0, 0], previous: [-2, 0, 0], velocity: [2, 0, 0], fresh: false };
	assert.equal(arrowStopped(arrow, { ...arrow, position: [1.5, 0, 0] }), true);
	assert.equal(arrowStopped(arrow, { ...arrow, velocity: [0, 0, 0] }), true);
	assert.equal(arrowStopped(arrow, { ...arrow, velocity: [1.98, -0.05, 0] }), false);
	assert.deepEqual(arrowHitPosition(arrow, [[1, 0.3, 0], [2, 2, 0]]), [1, 0, 0]);
	assert.equal(arrowHitPosition(arrow, [[5, 0, 0]]), null);
});

test("only nearby partial pickups count toward inventory gains and play pickup sounds", () => {
	const wasm = new WebAssembly.Module(readFileSync(new URL("../../wasm/client.wasm", import.meta.url)));
	const core = new ClientCore(new WebAssembly.Instance(wasm, {}));
	const played: Array<{ kind: Sound["kind"]; position?: Vec3 }> = [];
	const audio = new WorldAudio(core, [], { play: (sound, position) => played.push({ kind: sound.kind, position }) });
	const packet = (data: Uint8Array) => assert.equal(audio.packet(data, [0, 0, 0], new Map()), data[0]);

	const drop = (id: number, position: Vec3) => {
		const spawn = new Uint8Array(35);
		const view = new DataView(spawn.buffer);
		spawn[0] = S2C.EntitySpawn;
		view.setUint32(1, id);
		view.setUint16(6, 1);
		spawn[8] = 4;
		position.forEach((value, axis) => view.setFloat64(11 + axis * 8, value));
		packet(spawn);
		packet(Uint8Array.of(S2C.EntityCount, 0, 0, 0, id, 3));
		assert.equal(core.entities.find(entity => entity.id === id)?.count, 3);
	};
	const far: Vec3 = [4, 0.9, 0];
	const near: Vec3 = [1, 0.9, 0];
	const otherNear: Vec3 = [0, 0.9, 1];
	drop(1, far);
	drop(2, near);
	drop(3, otherNear);
	assert.deepEqual(played, []);
	const inventory = new Uint8Array(3 + 42 * 5 + 1 + 12 * 5 + 6 + 27 * 5);
	inventory.set([S2C.Inventory, 0, 36, 0, 1, 2]);
	packet(inventory);
	assert.deepEqual(played, [
		{ kind: "pickup", position: near },
		{ kind: "pickup", position: otherNear },
	]);
});

const eggSound = (broken: boolean): number[] => {
	const bytes = new Uint8Array(26), view = new DataView(bytes.buffer);
	bytes[0] = S2C.EggSound;
	view.setFloat64(1, 2.5);
	view.setFloat64(9, 4);
	view.setFloat64(17, -6);
	bytes[25] = Number(broken);
	return [...bytes];
};

for (const [packet, kind, filterType, title, position] of [
	[[S2C.ToolBreak], "toolBreak", "highpass", "an accepted ToolBreak packet plays the synthesized snap", undefined],
	[[S2C.Shear], "shear", "bandpass", "an accepted Shear packet plays the synthesized cut", undefined],
	[eggSound(false), "eggThrow", "bandpass", "a confirmed egg throw synthesizes a sound at the launch position", [2.5, 4, -6]],
	[eggSound(true), "eggBreak", "highpass", "a confirmed egg break synthesizes a sound at the impact position", [2.5, 4, -6]],
] as const) {
	test(title, async () => {
		const { instance } = await WebAssembly.instantiate(readFileSync(new URL("../../wasm/client.wasm", import.meta.url)), {});
		const core = new ClientCore(instance);
		const played: { sound: Sound; position: Vec3 | undefined }[] = [];
		const audio = new WorldAudio(core, [], { play: (sound, position) => played.push({ sound, position }) });
		const feet: Vec3 = [0, 0, 0];
		const ids = new Map();
		assert.equal(audio.packet(Uint8Array.of(...packet, 0), feet, ids), -1);
		assert.equal(audio.packet(Uint8Array.of(...packet), feet, ids), packet[0]);
		assert.deepEqual(played, [{ sound: { kind }, position }]);

		const starts: string[] = [];
		const stops: number[] = [];
		const node = { connect: () => node, disconnect() {} };
		const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
		const source = (kind: string) => ({
			...node,
			start: () => starts.push(kind),
			stop: (time: number) => stops.push(time),
			onended: null as (() => void) | null,
		});
		const oscillator = { ...source("tone"), frequency: param, type: "" };
		const noise = { ...source("noise"), buffer: null };
		const filter = { ...node, type: "", frequency: { value: 0 } };
		const context = {
			currentTime: 1,
			createGain: () => ({ ...node, gain: { ...param, value: 0 } }),
			createOscillator: () => oscillator,
			createBufferSource: () => noise,
			createBiquadFilter: () => filter,
		};
		let ended = false;
		playEffect(context as unknown as AudioContext, node as unknown as AudioNode,
			{ duration: 2 } as AudioBuffer, played[0].sound, 0.8, 0, () => { ended = true; });
		assert.deepEqual(starts, ["tone", "noise"]);
		assert.equal(oscillator.type, "triangle");
		assert.equal(filter.type, filterType);
		assert.equal(stops.length, 2);
		assert.equal(stops[0], stops[1]);
		assert.ok(stops[0] > 1);
		oscillator.onended?.();
		assert.ok(ended);
	});
}

test("a user gesture retries a pending resume and only the latest request can complete it", async t => {
	const requests: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
	const context = {
		state: "suspended",
		destination: {},
		sampleRate: 1,
		createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
		createBuffer: () => ({ getChannelData: () => new Float32Array(2) }),
		resume() {
			const request = Promise.withResolvers<void>();
			requests.push(request);
			return request.promise;
		},
		async suspend() { this.state = "suspended"; },
		async close() { this.state = "closed"; },
	};
	const saved = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
	Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: function () { return context; } });
	t.after(() => {
		if (saved) Object.defineProperty(globalThis, "AudioContext", saved);
		else Reflect.deleteProperty(globalThis, "AudioContext");
	});
	const warn = t.mock.method(console, "warn", () => {});
	const audio = new GameAudio({ x: 0, y: 0, z: 0, yaw: 0 });
	const play = t.mock.method(audio, "play", () => {});
	audio.activate(false);
	context.state = "running";
	requests[0].resolve();
	await setImmediate();

	audio.setVisible(false);
	audio.setVisible(true); // This attempt is outside a user gesture.
	audio.activate(true);
	audio.activate(true);
	assert.equal(requests.length, 4);
	requests[1].reject(new Error("superseded resume"));
	await setImmediate();
	assert.equal(audio.stats().state, "suspended");
	assert.equal(warn.mock.callCount(), 0);

	context.state = "running";
	requests[2].resolve();
	requests[3].resolve();
	await setImmediate();
	assert.equal(play.mock.callCount(), 1);
	assert.deepEqual(play.mock.calls[0].arguments, [{ kind: "click" }]);
	assert.equal(audio.stats().state, "running");

	audio.setVisible(false);
	audio.setVisible(true);
	audio.activate(true);
	const reason = new Error("latest resume failed");
	requests[5].reject(reason);
	await setImmediate();
	requests[4].reject(new Error("superseded after disable"));
	await setImmediate();
	assert.equal(audio.stats().state, "unavailable");
	assert.equal(play.mock.callCount(), 1);
	assert.deepEqual(warn.mock.calls.map(call => call.arguments), [["audio disabled", reason]]);
});
