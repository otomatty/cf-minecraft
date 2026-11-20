import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, keyLabel, defaultSettings, duplicateKeys, effectiveKeyConflicts, loadSettings, matchesKey, mouseDegrees, saveSettings, SETTINGS_KEY, sprintKey, LOCKABLE_CODES, validKey } from "./input-settings.ts";

const memory = () => {
	const values = new Map<string, string>();
	return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
const withoutInventory = (settings = defaultSettings()) => ({
	...settings,
	keys: Object.fromEntries(Object.entries(settings.keys).filter(([action]) => action !== "inventory")),
});

test("pre-inventory preferences retain all keys, sensitivity and FOV and persist the migration", () => {
	for (const key of [SETTINGS_KEY, "maincraft.input-settings.v1"]) {
		const storage = memory();
		const expected = { ...defaultSettings(), sensitivity: 37, fov: 96 };
		expected.keys.forward = "ArrowUp";
		expected.keys.down = "ShiftRight";
		storage.setItem(key, JSON.stringify(withoutInventory(expected)));
		assert.deepEqual(loadSettings(storage), expected);
		assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)!), expected);
		assert.equal(storage.getItem("maincraft.input-settings.v1"), null);
	}
});

test("old E bindings survive and inventory chooses the first free candidate", () => {
	for (const [extra, inventory] of [
		[{}, "KeyI"],
		[{ backward: "KeyI" }, "KeyB"],
		[{ backward: "KeyI", left: "KeyB" }, "KeyC"],
		[{ backward: "KeyI", left: "KeyB", right: "KeyC" }, "KeyA"],
		[{ backward: "KeyI", left: "KeyB", right: "KeyC", up: "KeyA", down: "KeyD" }, "KeyG"],
	] as const) {
		for (const key of [SETTINGS_KEY, "maincraft.input-settings.v1"]) {
			const storage = memory();
			const expected = { keys: { ...defaultSettings().keys, ...extra, forward: "KeyE", inventory }, sensitivity: 61, fov: 85 };
			storage.setItem(key, JSON.stringify(withoutInventory(expected)));
			const loaded = loadSettings(storage);
			assert.deepEqual(loaded, { ...expected, audio: defaultSettings().audio });
			assert.deepEqual(effectiveKeyConflicts(loaded), []);
			assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)!), { ...expected, audio: defaultSettings().audio });
		}
	}
});

test("inventory migration remains usable when saving fails and retries next load", () => {
	for (const key of [SETTINGS_KEY, "maincraft.input-settings.v1"]) {
		const storage = memory();
		const expected = { ...defaultSettings(), sensitivity: 55, fov: 88 };
		expected.keys.forward = "KeyE";
		expected.keys.inventory = "KeyI";
		const old = JSON.stringify(withoutInventory(expected));
		storage.setItem(key, old);
		assert.deepEqual(loadSettings({ ...storage, setItem() { throw new Error("quota"); } }), expected);
		assert.equal(storage.getItem(key), old);
		assert.deepEqual(loadSettings(storage), expected);
		assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)!), expected);
	}
});

test("inventory uses existing duplicate, modifier and sprint fallback conflict checks", () => {
	const storage = memory();
	for (const [sprint, inventory, duplicate, conflict] of [
		["KeyR", "KeyW", ["KeyW"], ["KeyW"]],
		["KeyR", "ShiftRight", ["ShiftLeft"], ["ShiftLeft"]],
		["KeyR", "ControlRight", [], ["ControlLeft"]],
		["ControlRight", "KeyR", [], ["KeyR"]],
	] as const) {
		const settings = { ...defaultSettings(), sensitivity: 62, fov: 91 };
		settings.keys.sprint = sprint;
		settings.keys.inventory = inventory;
		assert.deepEqual(duplicateKeys(settings.keys), duplicate);
		assert.deepEqual(effectiveKeyConflicts(settings), conflict);
		storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		assert.deepEqual(loadSettings(storage), defaultSettings());
	}
	const custom = defaultSettings();
	custom.keys.forward = "KeyE";
	custom.keys.inventory = "KeyI";
	assert.equal(saveSettings(storage, custom), true);
	assert.deepEqual(loadSettings(storage), custom);
});

test("migration does not repair invalid old preferences or explicit invalid inventory bindings", () => {
	const storage = memory();
	for (const value of [
		{ ...withoutInventory(), sensitivity: -1 },
		{ ...withoutInventory(), fov: 111 },
		{ ...withoutInventory(), keys: { ...withoutInventory().keys, forward: "Escape" } },
		{ ...withoutInventory(), keys: { ...withoutInventory().keys, forward: "KeyS" } },
		{ ...withoutInventory(), keys: { ...withoutInventory().keys, forward: "ControlRight" } },
		{ ...defaultSettings(), keys: { ...defaultSettings().keys, inventory: null } },
		{ ...defaultSettings(), keys: { ...defaultSettings().keys, inventory: "NotAKey" } },
	]) {
		const original = JSON.stringify(value);
		storage.setItem(SETTINGS_KEY, original);
		assert.deepEqual(loadSettings(storage), defaultSettings());
		assert.equal(storage.getItem(SETTINGS_KEY), original);
	}
});

test("defaults cover all actions and are independent copies", () => {
	const settings = defaultSettings();
	assert.equal(Object.keys(settings.keys).length, ACTIONS.length);
	assert.equal(settings.keys.sprint, "KeyR");
	assert.equal(settings.keys.fullscreen, "KeyF");
	assert.equal(settings.keys.inventory, "KeyE");
	assert.equal(settings.keys.chat, "KeyT");
	assert.equal(settings.sensitivity, 100);
	assert.equal(settings.fov, 70);
	settings.keys.forward = "ArrowUp";
	assert.equal(defaultSettings().keys.forward, "KeyW");
});
test("settings round trip, including range endpoints", () => {
	const storage = memory();
	assert.deepEqual(loadSettings(storage), defaultSettings());
	for (const [sensitivity, fov] of [[0, 30], [200, 110]]) {
		const settings = { ...defaultSettings(), sensitivity, fov };
		settings.keys.forward = "ArrowUp";
		assert.equal(saveSettings(storage, settings), true);
		assert.deepEqual(loadSettings(storage), settings);
	}
});
test("corrupt, incomplete, out of range and duplicate saved data fall back", () => {
	const storage = memory();
	const defaults = defaultSettings();
	for (const value of ["{", "null", "[]", "{}", JSON.stringify({ ...defaults, keys: {} }),
		JSON.stringify({ ...defaults, sensitivity: -1 }), JSON.stringify({ ...defaults, sensitivity: 201 }),
		JSON.stringify({ ...defaults, fov: 29 }), JSON.stringify({ ...defaults, fov: 111 }),
		JSON.stringify({ ...defaults, sensitivity: "100" }),
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "Escape" } }),
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "KeyE" } }),
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "NotAKey" } }),
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "KeyS" } })]) {
		storage.setItem(SETTINGS_KEY, value);
		assert.deepEqual(loadSettings(storage), defaults);
	}
});
test("legacy preferences migrate once and the current key takes precedence", () => {
	const storage = memory();
	const legacyKey = "maincraft.input-settings.v1";
	const settings = { ...defaultSettings(), sensitivity: 42, fov: 90 };
	settings.keys.forward = "ArrowUp";
	storage.setItem(legacyKey, JSON.stringify(settings));
	assert.deepEqual(loadSettings(storage), settings);
	assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)!), settings);
	assert.equal(storage.getItem(legacyKey), null);
	storage.setItem(legacyKey, JSON.stringify(defaultSettings()));
	assert.deepEqual(loadSettings(storage), settings);
	assert.notEqual(storage.getItem(legacyKey), null);
	storage.setItem(SETTINGS_KEY, "{");
	assert.deepEqual(loadSettings(storage), defaultSettings());
	assert.equal(storage.getItem(SETTINGS_KEY), "{");
});
test("invalid legacy preferences fall back without migrating", () => {
	const storage = memory();
	const legacyKey = "maincraft.input-settings.v1";
	for (const value of ["{", "null", "{}", JSON.stringify({ ...defaultSettings(), fov: 111 })]) {
		storage.setItem(legacyKey, value);
		assert.deepEqual(loadSettings(storage), defaultSettings());
		assert.equal(storage.getItem(SETTINGS_KEY), null);
		assert.equal(storage.getItem(legacyKey), value);
	}
});
test("migration storage failures retain preferences and do not discard the old key", () => {
	const legacyKey = "maincraft.input-settings.v1";
	const settings = { ...defaultSettings(), sensitivity: 42 };
	for (const method of ["setItem", "removeItem"] as const) {
		const storage = memory();
		storage.setItem(legacyKey, JSON.stringify(settings));
		assert.deepEqual(loadSettings({ ...storage, [method]() { throw new Error("denied"); } }), settings);
		assert.equal(storage.getItem(legacyKey), JSON.stringify(settings));
		assert.equal(storage.getItem(SETTINGS_KEY), method === "setItem" ? null : JSON.stringify(settings));
	}
});
test("storage exceptions are contained", () => {
	assert.deepEqual(loadSettings({ ...memory(), getItem() { throw new Error("denied"); } }), defaultSettings());
	assert.equal(saveSettings({ setItem() { throw new Error("quota"); } }, defaultSettings()), false);
});
test("duplicates report each repeated key once", () => {
	const keys = defaultSettings().keys;
	assert.deepEqual(duplicateKeys(keys), []);
	keys.backward = keys.left = keys.forward;
	assert.deepEqual(duplicateKeys(keys), ["KeyW"]);
});
test("mouse sensitivity follows the cubic formula and preserves the old default", () => {
	assert.equal(mouseDegrees(100), 0.15);
	assert.ok(Math.abs(mouseDegrees(0) - 0.0096) < 1e-12);
	assert.ok(Math.abs(mouseDegrees(200) - 0.6144) < 1e-12);
	assert.equal(mouseDegrees(-10), mouseDegrees(0));
	assert.equal(mouseDegrees(210), mouseDegrees(200));
});
test("Ctrl sprint requires successful keyboard lock; custom keys are preserved", () => {
	const settings = defaultSettings();
	assert.equal(sprintKey(settings, false), "KeyR");
	assert.equal(sprintKey(settings, true), "ControlLeft");
	settings.keys.sprint = "KeyT";
	assert.equal(sprintKey(settings, true), "KeyT");
	for (const code of ["ControlLeft", "ControlRight"]) {
		settings.keys.sprint = code;
		assert.equal(sprintKey(settings, false), "KeyR");
		assert.equal(sprintKey(settings, true), code);
	}
});

test("assignments preserve reserved keys and Keyboard Lock excludes Escape", () => {
	for (const code of ["Escape", "F8", "F11", "Unidentified", "NotAKey", ""]) assert.equal(validKey(code), false);
	for (const code of ["KeyE", "KeyW", "ControlLeft", "ControlRight", "ArrowUp", "Numpad0", "IntlYen"]) assert.equal(validKey(code), true);
	assert.equal(LOCKABLE_CODES.includes("Escape"), false);
	for (const code of ["KeyW", "ControlLeft", "ControlRight"]) assert.ok(LOCKABLE_CODES.includes(code));
});

test("both sides of each modifier match the assigned key", () => {
	assert.equal(matchesKey("ShiftRight", defaultSettings().keys.down), true);
	for (const modifier of ["Shift", "Control", "Alt", "Meta"]) {
		assert.equal(matchesKey(`${modifier}Left`, `${modifier}Right`), true);
		assert.equal(matchesKey(`${modifier}Right`, `${modifier}Left`), true);
		assert.equal(matchesKey(`${modifier}Right`, `${modifier}Right`), true);
	}
	assert.equal(matchesKey("KeyW", "KeyW"), true);
	assert.equal(matchesKey("KeyW", "KeyS"), false);
	assert.equal(matchesKey("ShiftRight", "ControlLeft"), false);
	assert.equal(matchesKey("AltRight", "MetaLeft"), false);
});
test("opposite modifier sides are duplicate assignments and rejected on load", () => {
	const storage = memory();
	for (const modifier of ["Shift", "Control", "Alt", "Meta"]) {
		const settings = defaultSettings();
		settings.keys.up = `${modifier}Right`;
		settings.keys.down = `${modifier}Left`;
		assert.deepEqual(duplicateKeys(settings.keys), [`${modifier}Left`]);
		storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		assert.deepEqual(loadSettings(storage), defaultSettings());
	}
});
test("assignment validation rejects sprint fallback conflicts in either lock state", () => {
	assert.deepEqual(effectiveKeyConflicts(defaultSettings()), []);
	for (const sprint of ["ControlLeft", "ControlRight"]) {
		const settings = defaultSettings();
		settings.keys.sprint = sprint;
		const candidate = { ...settings, keys: { ...settings.keys, fullscreen: "KeyR" } };
		assert.deepEqual(duplicateKeys(candidate.keys), []);
		assert.deepEqual(effectiveKeyConflicts(candidate), ["KeyR"]);
		assert.equal(settings.keys.fullscreen, "KeyF");
	}
	const settings = defaultSettings();
	settings.keys.forward = "ControlRight";
	assert.deepEqual(duplicateKeys(settings.keys), []);
	assert.deepEqual(effectiveKeyConflicts(settings), ["ControlLeft"]);
	settings.keys.sprint = "KeyY";
	assert.deepEqual(effectiveKeyConflicts(settings), []);
});
test("saved sprint fallback conflicts reset to defaults; safe custom bindings still load", () => {
	const storage = memory();
	for (const sprint of ["ControlLeft", "ControlRight", "KeyR"]) {
		const settings = defaultSettings();
		settings.keys.sprint = sprint;
		if (sprint === "KeyR") settings.keys.forward = "ControlRight";
		else settings.keys.fullscreen = "KeyR";
		storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		assert.deepEqual(loadSettings(storage), defaultSettings());
	}
	const settings = defaultSettings();
	settings.keys.down = "ShiftRight";
	settings.keys.sprint = "ControlRight";
	assert.equal(saveSettings(storage, settings), true);
	assert.deepEqual(loadSettings(storage), settings);
});

test("key labels shorten letter, digit, modifier and arrow codes and preserve other codes", () => {
	for (const [code, label] of Object.entries({
		KeyW: "W", KeyZ: "Z", Digit1: "1", Digit0: "0", Space: "Space",
		ShiftLeft: "Shift", ShiftRight: "Shift", ControlLeft: "Ctrl", AltLeft: "Alt",
		ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
		ControlRight: "ControlRight", AltRight: "AltRight", F8: "F8", Numpad1: "Numpad1", Unknown: "Unknown", KeyWW: "KeyWW", toString: "toString",
	})) assert.equal(keyLabel(code), label);
});

test("pre-audio settings preserve controls and get the default volumes", () => {
	const storage = memory();
	const keys = { ...defaultSettings().keys, forward: "ArrowUp" };
	const old = { keys, sensitivity: 54, fov: 85 };
	storage.setItem(SETTINGS_KEY, JSON.stringify(old));
	const loaded = loadSettings(storage);
	assert.deepEqual(loaded, { ...old, audio: { master: 80, effects: 100, music: 60 } });
	loaded.audio = { master: 50, effects: 76, music: 0 };
	assert.equal(saveSettings(storage, loaded), true);
	assert.deepEqual(loadSettings(storage), loaded);
});

test("invalid individual volumes fall back independently", () => {
	const storage = memory();
	const settings = { ...defaultSettings(), sensitivity: 43 };
	storage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, audio: { master: 101, effects: "10", music: 0 } }));
	assert.deepEqual(loadSettings(storage), { ...settings, audio: { master: 80, effects: 100, music: 0 } });
});

test("pre-chat settings preserve custom bindings and select a free chat key", () => {
	for (const storageKey of [SETTINGS_KEY, "maincraft.input-settings.v1"]) {
		for (const forward of ["ArrowUp", "KeyT"]) {
			const storage = memory();
			const expected = { ...defaultSettings(), sensitivity: 73, fov: 89 };
			expected.keys.forward = forward;
			expected.keys.chat = forward === "KeyT" ? "KeyB" : "KeyT";
			const { chat, ...keys } = expected.keys;
			storage.setItem(storageKey, JSON.stringify({ ...expected, keys }));
			assert.deepEqual(loadSettings(storage), expected);
			assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_KEY)!), expected);
		}
	}
});
