/** Mining presentation clock. Only an authoritative block change completes a dig. */
export interface DigTarget { x: number; y: number; z: number; state: number; ticks: number }
export interface DigState { active: (DigTarget & { started: number; stage: number }) | null; readyAt: number }
export type DigCommand = { type: "start"; target: DigTarget } | { type: "abort" };
export const newDigState = (): DigState => ({ active: null, readyAt: 0 });

export function advanceDig(
	state: DigState, held: boolean, target: DigTarget | null, currentState: number | null, now: number,
): { state: DigState; commands: DigCommand[] } {
	let active = state.active, readyAt = state.readyAt;
	const commands: DigCommand[] = [];
	if (active && currentState !== active.state) {
		commands.push({ type: "abort" });
		if (currentState === 0) readyAt = now + 250;
		active = null;
	}
	if (!held) {
		if (active) commands.push({ type: "abort" });
		return { state: { active: null, readyAt }, commands };
	}
	const same = active && target && active.x === target.x && active.y === target.y && active.z === target.z && active.state === target.state;
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
	return { state: { active, readyAt }, commands };
}

export interface DigOverlay { x: number; y: number; z: number; stage: number }

/** Same item vertex layout, with a slightly expanded stationary cube. */
export function digVertices(digs: readonly DigOverlay[], camera: readonly number[], textureBase: number): Float32Array {
	const out: number[] = [];
	const corners = [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,1,0],[1,1,0],[1,1,1],[0,1,1]];
	const faces = [[0,1,2,3],[7,6,5,4],[1,0,4,5],[3,2,6,7],[0,3,7,4],[2,1,5,6]];
	for (const dig of digs) for (const face of faces) for (const i of [0,1,2,0,2,3]) {
		const v = corners[face[i]];
		out.push(dig.x - camera[0] + v[0] * 1.004 - .002,
			dig.y - camera[1] + v[1] * 1.004 - .002,
			dig.z - camera[2] + v[2] * 1.004 - .002,
			[0,1,1,0][i], [1,1,0,0][i], 1, textureBase + dig.stage, .96875, .96875);
	}
	return new Float32Array(out);
}
