/** Mining presentation clock. Only an authoritative block change completes a dig. */
export interface DigTarget { x: number; y: number; z: number; state: number; ticks: number; selection?: string }
export interface DigState { active: (DigTarget & { started: number; stage: number }) | null; readyAt: number; invalidated: boolean }
export type DigCommand = { type: "start"; target: DigTarget } | { type: "abort" };
export const newDigState = (): DigState => ({ active: null, readyAt: 0, invalidated: false });

/** Preserve intermediate updates even if the target is restored before the next frame. */
export function observeDigBlockUpdate(state: DigState, x: number, y: number, z: number, block: number, now: number): DigState {
	const a = state.active;
	if (!a || a.x !== x || a.y !== y || a.z !== z) return state;
	return { ...state, invalidated: true, readyAt: block === 0 ? Math.max(state.readyAt, now + 250) : state.readyAt };
}

export function advanceDig(
	state: DigState, held: boolean, target: DigTarget | null, currentState: number | null, now: number,
): { state: DigState; commands: DigCommand[] } {
	let active = state.active, readyAt = state.readyAt;
	const commands: DigCommand[] = [];
	if (active && (state.invalidated || currentState !== active.state)) {
		commands.push({ type: "abort" });
		if (currentState === 0) readyAt = now + 250;
		active = null;
	}
	if (!held) {
		if (active) commands.push({ type: "abort" });
		return { state: { active: null, readyAt, invalidated: false }, commands };
	}
	const same = active && target && active.x === target.x && active.y === target.y && active.z === target.z && active.state === target.state && active.selection === target.selection;
	if (active && !same) {
		commands.push({ type: "abort" });
		active = null;
	}
	if (!active && target && now >= readyAt) {
		active = { ...target, started: now, stage: 0 };
		commands.push({ type: "start", target });
	}
	if (active) {
		const elapsedTicks = Math.max(0, Math.floor((now - active.started) / 50));
		active = { ...active, stage: active.ticks === 0 ? 9 : Math.min(9, Math.floor(elapsedTicks * 10 / active.ticks)) };
	}
	return { state: { active, readyAt, invalidated: false }, commands };
}

export interface DigOverlay { x: number; y: number; z: number; stage: number }
export interface DigBounds { min: readonly number[]; max: readonly number[] }
export interface RenderDig extends DigOverlay { bounds: DigBounds }

/** Same item vertex layout, with a small margin around the selection bounds. */
export function digVertices(digs: readonly RenderDig[], camera: readonly number[], textureBase: number): Float32Array {
	const out: number[] = [];
	const corners = [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,1,0],[1,1,0],[1,1,1],[0,1,1]];
	const faces = [[0,1,2,3],[7,6,5,4],[1,0,4,5],[3,2,6,7],[0,3,7,4],[2,1,5,6]];
	for (const dig of digs) for (const face of faces) for (const i of [0,1,2,0,2,3]) {
		const v = corners[face[i]];
		const { min, max } = dig.bounds;
		out.push(dig.x - camera[0] + min[0] + v[0] * (max[0] - min[0] + .004) - .002,
			dig.y - camera[1] + min[1] + v[1] * (max[1] - min[1] + .004) - .002,
			dig.z - camera[2] + min[2] + v[2] * (max[2] - min[2] + .004) - .002,
			[0,1,1,0][i], [1,1,0,0][i], 1, textureBase + dig.stage, .96875, .96875);
	}
	return new Float32Array(out);
}

/** Called for each inventory/selection update, including changes between frames. */
export function invalidateDigSelection(state: DigState): DigState {
    return state.active ? { ...state, invalidated: true } : state;
}

/** Mining depends on the slot and item identity, independent of stack count. */
export function digSelection(slot: number, stack: { item: number } | null | undefined): string {
	return JSON.stringify([slot, stack?.item ?? null]);
}
