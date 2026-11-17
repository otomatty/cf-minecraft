import type { InventorySlot } from "./client-core.ts";
export const INVENTORY_ROWS = [
    Array.from({ length: 27 }, (_, i) => i + 9),
    Array.from({ length: 9 }, (_, i) => i),
    [36, 37, 38, 39],
    [40],
];
export const TABLE_ROWS = [INVENTORY_ROWS[0], INVENTORY_ROWS[1],
    Array.from({ length: 9 }, (_, i) => i + 41), [50]];

/** Translate a wire slot into the client display array, keeping cursor 41 separate. */
export function inventoryDisplayIndex(slot: number, table = false): number {
    return table && slot >= 41 && slot <= 49 ? slot + 1 : table && slot === 50 ? 40 : slot;
}
export function inventoryDisplay(slots: readonly (InventorySlot | null)[], table = false) {
    return {
        groups: (table ? TABLE_ROWS : INVENTORY_ROWS).map(row => row.map(slot => ({ slot, stack: slots[inventoryDisplayIndex(slot, table)] ?? null }))),
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

export function tableScreenVisible({ screen, closePending }: { screen: number; closePending: boolean }): boolean {
    return screen === 1 && !closePending;
}
