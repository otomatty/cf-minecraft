/** Input preferences and key policy, independent of browser/DOM globals. */
export const ACTIONS = ["forward", "backward", "left", "right", "up", "down", "sprint", "fullscreen"] as const;
export type Action = typeof ACTIONS[number];
export interface InputSettings {
	keys: Record<Action, string>;
	sensitivity: number; // Percent: 0..200, mapped to the game's 0..1 range.
	fov: number;
}
export const SETTINGS_KEY = "maincraft.input-settings.v1";
export function defaultSettings(): InputSettings {
	return {
		keys: { forward: "KeyW", backward: "KeyS", left: "KeyA", right: "KeyD", up: "Space", down: "ShiftLeft", sprint: "KeyR", fullscreen: "KeyF" },
		sensitivity: 100,
		fov: 70,
	};
}
/** Treat the two physical keys of each modifier as one binding. */
function normalizedKey(code: string): string {
	return code.replace(/^(Shift|Control|Alt|Meta)(Left|Right)$/, "$1Left");
}
export function matchesKey(code: string, assigned: string): boolean {
	return normalizedKey(code) === normalizedKey(assigned);
}
export function duplicateKeys(keys: Record<Action, string>): string[] {
	return [...new Set(ACTIONS.map(action => normalizedKey(keys[action])).filter((code, i, codes) => codes.indexOf(code) !== i))];
}
/** Check both runtime key maps, including the sprint fallback when lock is unavailable. */
export function effectiveKeyConflicts(settings: InputSettings): string[] {
	return [...new Set([false, true].flatMap(active => duplicateKeys({ ...settings.keys, sprint: sprintKey(settings, active) })))];
}
/** Standard physical key codes; Escape is deliberately never requested by Keyboard Lock. */
export const LOCKABLE_CODES = [
	...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
	...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
	...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
	...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
	"ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
	"Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
	"ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "CapsLock", "NumLock", "ScrollLock", "Pause", "PrintScreen",
	"Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash",
	"IntlBackslash", "IntlRo", "IntlYen", "Convert", "NonConvert", "KanaMode", "Lang1", "Lang2", "Lang3", "Lang4", "Lang5",
	"NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter", "NumpadEqual", "NumpadComma", "ContextMenu",
];
export function validKey(code: unknown): code is string {
	return typeof code === "string" && LOCKABLE_CODES.includes(code) && !["F8", "F11"].includes(code);
}
interface StorageReader { getItem(key: string): string | null }
interface StorageWriter { setItem(key: string, value: string): void }
export function loadSettings(storage: StorageReader): InputSettings {
	try {
		const value = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
		if (!value || !value.keys || !ACTIONS.every(action => validKey(value.keys[action]))
			|| duplicateKeys(value.keys).length > 0 || effectiveKeyConflicts(value).length > 0
			|| !Number.isFinite(value.sensitivity) || value.sensitivity < 0 || value.sensitivity > 200
			|| !Number.isFinite(value.fov) || value.fov < 30 || value.fov > 110) return defaultSettings();
		return { keys: Object.fromEntries(ACTIONS.map(action => [action, value.keys[action]])) as Record<Action, string>, sensitivity: value.sensitivity, fov: value.fov };
	} catch {
		return defaultSettings();
	}
}
export function saveSettings(storage: StorageWriter, settings: InputSettings): boolean {
	try {
		storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		return true;
	} catch {
		return false;
	}
}
export function mouseDegrees(percent: number): number {
	const sensitivity = Math.max(0, Math.min(200, percent)) / 200;
	const f = sensitivity * 0.6 + 0.2;
	return f * f * f * 8.0 * 0.15;
}
/** Ctrl sprint is safe only after Keyboard Lock actually succeeds. */
export function sprintKey(settings: InputSettings, keyboardLocked: boolean): string {
	const code = settings.keys.sprint;
	if (code === "ControlLeft" || code === "ControlRight") return keyboardLocked ? code : "KeyR";
	return code === "KeyR" && keyboardLocked ? "ControlLeft" : code;
}
