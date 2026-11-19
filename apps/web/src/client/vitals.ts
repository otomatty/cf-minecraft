export const MAX_HEALTH = 20;
export const MAX_AIR = 300;
export const MAX_FOOD = 20;

export const deathCauses = ["", "落下してやられた", "ブロックの中で窒息した", "溺れた", "奈落に落ちた", "溶岩で焼けた", "ゾンビに倒された", "矢で射抜かれた"];

function meterStates(value: number, max: number): Array<"full" | "half" | "empty"> {
	return Array.from({ length: max / 2 }, (_, i) => {
		const remaining = value - i * 2;
		return remaining >= 2 ? "full" : remaining === 1 ? "half" : "empty";
	});
}

export function heartStates(health: number) {
	return meterStates(health, MAX_HEALTH);
}

// Index 0 is the rightmost icon.
export function foodStates(food: number) {
	return meterStates(food, MAX_FOOD);
}

export function bubbleCount(air: number): number {
	return Math.ceil(air / 30);
}
