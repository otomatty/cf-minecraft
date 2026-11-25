/** Empty and non-placeable item slots have no block icon or placement state. */
export function hotbarStates(slots: readonly ({ item: number } | null)[], items: readonly { id: number; block: number | null }[]): number[] {
	return slots.slice(0, 9).map(slot => slot ? items.find(item => item.id === slot.item)?.block ?? 0 : 0);
}

export function pickBlockItem<T extends { name: string; block: number | null }>(
	block: { name: string; first: number } | undefined, items: readonly T[],
): T | undefined {
	if (!block || block.first === 0) return undefined;
	return items.find(item => item.block === block.first)
		?? (block.name === "wall_torch" ? items.find(item => item.name === "torch") : undefined)
		?? (block.name === "oak_leaves" ? items.find(item => item.name === block.name) : undefined);
}

export function durabilityBar(damage: number, max: number | null): { fraction: number; color: string } | null {
	if (max === null || damage <= 0) return null;
	const fraction = Math.max(0, (max - damage) / max);
	return { fraction, color: `hsl(${Math.round(120 * fraction)}, 85%, 55%)` };
}
