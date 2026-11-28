import type { InventorySlot } from "./client-core.ts";
export const INVENTORY_ROWS = [
    Array.from({ length: 27 }, (_, i) => i + 9),
    Array.from({ length: 9 }, (_, i) => i),
    [36, 37, 38, 39],
    [40],
];
export const TABLE_ROWS = [INVENTORY_ROWS[0], INVENTORY_ROWS[1],
    Array.from({ length: 9 }, (_, i) => i + 41), [50]];

export const FURNACE_ROWS = [INVENTORY_ROWS[0], INVENTORY_ROWS[1], [51, 52], [53]];
export const CHEST_ROWS = [Array.from({ length: 27 }, (_, i) => i + 54), INVENTORY_ROWS[0], INVENTORY_ROWS[1]];
export type InventoryScreenKind = 0 | 1 | 2 | 3;
export const SCREEN_ROWS = [INVENTORY_ROWS, TABLE_ROWS, FURNACE_ROWS, CHEST_ROWS] as const;

/** Most wire slots, including chest slots 54–80, match the display array. Table crafting skips cursor 41. */
export function inventoryDisplayIndex(slot: number, kind: InventoryScreenKind = 0): number {
    return kind === 1 && slot >= 41 && slot <= 49 ? slot + 1 : kind === 1 && slot === 50 ? 40 : slot;
}
export function inventoryDisplay(slots: readonly (InventorySlot | null)[], kind: InventoryScreenKind = 0) {
    return {
        groups: SCREEN_ROWS[kind].map(row => row.map(slot => ({ slot, stack: slots[inventoryDisplayIndex(slot, kind)] ?? null }))),
        cursor: slots[41] ?? null,
    };
}

/** Native button activation covers both pointer and keyboard input. */
export function bindInventorySlot(
    button: Pick<HTMLButtonElement, "addEventListener">,
    slot: number,
    send: (slot: number, button: 0 | 1, shift: boolean) => void,
): void {
    button.addEventListener("click", event => send(slot, 0, event.shiftKey));
    button.addEventListener("contextmenu", event => {
        event.preventDefault();
        send(slot, 1, event.button === 2 && event.shiftKey);
    });
}

/** Local close intent survives stale Inventory packets until confirmed or superseded. */
export function updateClosePending(
    closePending: boolean,
    event: { type: "close" } | { type: "use" } | { type: "inventory"; screen: number },
): boolean {
    if (event.type === "close") return true;
    if (event.type === "use") return false;
    return event.screen === 0 ? false : closePending;
}

export function containerScreenVisible({ screen, closePending }: { screen: number; closePending: boolean }, kind: Exclude<InventoryScreenKind, 0>): boolean {
    return screen === kind && !closePending;
}
