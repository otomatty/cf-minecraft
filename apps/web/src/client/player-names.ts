import type { RenderPlayer } from "./entities.ts";
import type { Vec3 } from "./mobs/model.ts";

/** Project the name anchor to fractions of the viewport, using WebGPU clip depth. */
export function projectPlayerName(position: Vec3, eye: Vec3, viewProjection: Float32Array): [number, number] | null {
	const x = position[0] - eye[0], y = position[1] - eye[1] + 2.1, z = position[2] - eye[2];
	if (x * x + y * y + z * z > 32 ** 2) return null;
	const clip = (row: number) => viewProjection[row] * x + viewProjection[row + 4] * y
		+ viewProjection[row + 8] * z + viewProjection[row + 12];
	const w = clip(3);
	if (w <= 0) return null;
	const clipX = clip(0), clipY = clip(1), depth = clip(2);
	if (Math.abs(clipX) > w || Math.abs(clipY) > w || depth < 0 || depth > w) return null;
	return [(clipX / w + 1) / 2, (1 - clipY / w) / 2];
}

export class PlayerNames {
	private readonly labels = new Map<number, HTMLDivElement>();
	private readonly container: HTMLElement;

	constructor(container: HTMLElement) {
		this.container = container;
	}

	update(players: readonly RenderPlayer[], visible: readonly RenderPlayer[], eye: Vec3, viewProjection: Float32Array): void {
		const shown = new Set<number>();
		for (const { id, name, position } of visible) {
			const point = projectPlayerName(position, eye, viewProjection);
			if (!point) continue;
			shown.add(id);
			let label = this.labels.get(id);
			if (!label) {
				label = document.createElement("div");
				label.dataset.playerId = String(id);
				this.labels.set(id, label);
				this.container.append(label);
			}
			if (label.textContent !== name) label.textContent = name;
			const transform = `translate(${point[0] * 100}vw, ${point[1] * 100}vh) translate(-50%, -100%)`;
			if (label.style.transform !== transform) label.style.transform = transform;
			if (label.hidden) label.hidden = false;
		}
		if (this.labels.size === shown.size) return;
		const connected = new Set(players.map(player => player.id));
		for (const [id, label] of this.labels) {
			if (!connected.has(id)) {
				label.remove();
				this.labels.delete(id);
			} else if (!shown.has(id) && !label.hidden) {
				label.hidden = true;
			}
		}
	}
}
