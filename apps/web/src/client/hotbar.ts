import type { BlockStateInfo } from "./placement.ts";

export const HOTBAR_KEY = "cf-minecraft.hotbar.v1";
const DEFAULTS = ["stone", "dirt", "oak_planks", "oak_slab", "oak_log", "glass", "oak_leaves", "water", "lamp_block"];
type Reader = { getItem(key: string): string | null };
type Writer = { setItem(key: string, value: string): void };

export function defaultHotbar(registry: readonly BlockStateInfo[]): number[] {
	return DEFAULTS.map(name => registry.findIndex(block => block.name === name));
}

/** Save block names, so state ordering does not become part of the preference format. */
export function loadHotbar(storage: Reader, registry: readonly BlockStateInfo[]): number[] {
	try {
		const names: unknown = JSON.parse(storage.getItem(HOTBAR_KEY) ?? "null");
		if (Array.isArray(names) && names.length === 9) {
			const slots = names.map(name => typeof name === "string" && name !== "air" ? registry.findIndex(b => b.name === name) : -1);
			if (slots.every(state => state > 0)) return slots;
		}
	} catch { /* Unavailable or corrupt preferences use defaults. */ }
	return defaultHotbar(registry);
}

export function saveHotbar(storage: Writer, slots: readonly number[], registry: readonly BlockStateInfo[]): boolean {
	try {
		storage.setItem(HOTBAR_KEY, JSON.stringify(slots.map(state => registry[state].name)));
		return true;
	} catch { return false; }
}
