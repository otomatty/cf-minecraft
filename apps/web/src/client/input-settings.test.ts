import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, defaultSettings, duplicateKeys, effectiveKeyConflicts, loadSettings, matchesKey, mouseDegrees, saveSettings, SETTINGS_KEY, sprintKey, LOCKABLE_CODES, validKey } from "./input-settings.ts";

const memory = () => {
	const values = new Map<string, string>();
	return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
test("defaults cover eight actions and are independent copies", () => {
	const settings = defaultSettings();
	assert.equal(Object.keys(settings.keys).length, ACTIONS.length);
	assert.equal(settings.keys.sprint, "KeyR");
	assert.equal(settings.keys.fullscreen, "KeyF");
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
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "NotAKey" } }),
		JSON.stringify({ ...defaults, keys: { ...defaults.keys, forward: "KeyS" } })]) {
		storage.setItem(SETTINGS_KEY, value);
		assert.deepEqual(loadSettings(storage), defaults);
	}
});
test("storage exceptions are contained", () => {
	assert.deepEqual(loadSettings({ getItem() { throw new Error("denied"); } }), defaultSettings());
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
	for (const code of ["KeyW", "ControlLeft", "ControlRight", "ArrowUp", "Numpad0", "IntlYen"]) assert.equal(validKey(code), true);
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
	settings.keys.sprint = "KeyT";
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
