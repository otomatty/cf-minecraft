/** Empty and non-placeable item slots have no block icon or placement state. */
export function hotbarStates(slots: readonly ({ item: number } | null)[], items: readonly { id: number; block: number | null }[]): number[] {
	return slots.slice(0, 9).map(slot => slot ? items.find(item => item.id === slot.item)?.block ?? 0 : 0);
}
