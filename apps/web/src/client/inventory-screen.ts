import type { InventorySlot } from "./client-core.ts";
export const INVENTORY_ROWS = [
    Array.from({ length: 27 }, (_, i) => i + 9),
    Array.from({ length: 9 }, (_, i) => i),
    [36, 37, 38, 39],
    [40],
];
export function inventoryDisplay(slots: readonly (InventorySlot | null)[]) {
    return {
        groups: INVENTORY_ROWS.map(row => row.map(slot => ({ slot, stack: slots[slot] ?? null }))),
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
        send(slot, 1, event.shiftKey);
    });
}
