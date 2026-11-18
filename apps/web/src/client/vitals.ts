export const MAX_HEALTH = 20;
export const MAX_AIR = 300;

export function heartStates(health: number): Array<"full" | "half" | "empty"> {
	return Array.from({ length: MAX_HEALTH / 2 }, (_, i) => {
		const remaining = health - i * 2;
		return remaining >= 2 ? "full" : remaining === 1 ? "half" : "empty";
	});
}

export function bubbleCount(air: number): number {
	return Math.ceil(air / 30);
}
