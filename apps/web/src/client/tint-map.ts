import { GRASS_TINT, LEAVES_TINT, WATER_TINT } from "./textures.ts";

export interface TintRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Contiguous RGBA8 images in grass, leaves, water layer order. */
	data: Uint8Array<ArrayBuffer>;
}
export interface CellTint {
	biome: number;
	grass: [number, number, number];
	leaves: [number, number, number];
	water: [number, number, number];
}

/** Spend 8% of the previous frame interval, bounded to 1–10ms. */
export function tintBudgetMs(frameDtMs: number): number {
	return Math.max(1, Math.min(10, frameDtMs * 0.08));
}

/** CPU mirror of a repeating 1024-block square. No GPU or WASM dependencies. */
export class TintMap {
	private readonly owners: Array<[number, number] | undefined> = new Array(64 * 64);
	private readonly biomes = new Uint8Array(256 * 256);
	private readonly pixels = Array.from({ length: 3 }, () => new Uint8Array(256 * 256 * 4));
	private pending: Array<[number, number]> = [];
	private cursor = 0;
	private region = "";
	private seed: bigint | null = null;
	private generator: number | null = null;
	private uploads: TintRect[] = [];
	private readonly colors: Uint8Array;
	private readonly cells: (cx: number, cz: number) => Uint8Array;
	private readonly now: () => number;

	constructor(colors: Uint8Array, cells: (cx: number, cz: number) => Uint8Array, now = () => performance.now()) {
		this.colors = colors.slice();
		this.cells = cells;
		this.now = now;
		this.reset();
	}

	setWorld(seed: bigint | null, generator: number | null): void {
		if (seed === this.seed && generator === this.generator) return;
		this.seed = seed;
		this.generator = generator;
		this.reset();
	}

	private reset(): void {
		this.owners.fill(undefined);
		this.pending = [];
		this.cursor = 0;
		this.region = "";
		this.uploads = [];
		const combined = new Uint8Array(256 * 256 * 4 * 3);
		[GRASS_TINT, LEAVES_TINT, WATER_TINT].forEach((rgb, layer) => {
			const data = this.pixels[layer];
			for (let i = 0; i < data.length; i += 4) {
				data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
			}
			combined.set(data, layer * data.length);
		});
		this.uploads.push({ x: 0, y: 0, width: 256, height: 256, data: combined });
	}

	update(cameraChunkX: number, cameraChunkZ: number, radius: number, budgetMs = 1): void {
		if (this.seed === null || this.generator !== 2) return;
		// A square wider than 64 chunks cannot fit in this torus simultaneously.
		if (!Number.isInteger(radius) || radius < 0 || radius > 31) throw new RangeError("Tint radius must be 0..31");
		const region = `${cameraChunkX},${cameraChunkZ},${radius}`;
		if (region !== this.region) {
			this.region = region;
			this.pending = [];
			this.cursor = 0;
			for (let z = cameraChunkZ - radius; z <= cameraChunkZ + radius; z++) {
				for (let x = cameraChunkX - radius; x <= cameraChunkX + radius; x++) {
					if (!this.has(x, z)) this.pending.push([x, z]);
				}
			}
			this.pending.sort((a, b) => (a[0] - cameraChunkX) ** 2 + (a[1] - cameraChunkZ) ** 2 - (b[0] - cameraChunkX) ** 2 - (b[1] - cameraChunkZ) ** 2);
		}
		if (this.cursor === this.pending.length) return;
		const start = this.now();
		while (this.cursor < this.pending.length && this.now() - start < budgetMs) {
			const [cx, cz] = this.pending[this.cursor++];
			const cells = this.cells(cx, cz);
			const x = (cx & 63) * 4, y = (cz & 63) * 4;
			const combined = new Uint8Array(4 * 4 * 4 * 3);
			for (let layer = 0; layer < 3; layer++) {
				const pixels = this.pixels[layer];
				for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
					const cell = j * 4 + i, offset = cells[cell] * 9 + layer * 3;
					const r = this.colors[offset], g = this.colors[offset + 1], b = this.colors[offset + 2];
					const dest = layer * 64 + cell * 4;
					combined[dest] = r; combined[dest + 1] = g; combined[dest + 2] = b; combined[dest + 3] = 255;
					const texel = (y + j) * 256 + x + i;
					const pixel = texel * 4;
					pixels[pixel] = r; pixels[pixel + 1] = g; pixels[pixel + 2] = b; pixels[pixel + 3] = 255;
					this.biomes[texel] = cells[cell];
				}
			}
			this.uploads.push({ x, y, width: 4, height: 4, data: combined });
			this.owners[(cz & 63) * 64 + (cx & 63)] = [cx, cz];
		}
	}

	private has(cx: number, cz: number): boolean {
		const owner = this.owners[(cz & 63) * 64 + (cx & 63)];
		return owner?.[0] === cx && owner[1] === cz;
	}

	takeUploads(): TintRect[] {
		const uploads = this.uploads;
		this.uploads = [];
		return uploads;
	}

	tint(x: number, z: number): CellTint | null {
		if (!this.has(Math.floor(x / 16), Math.floor(z / 16))) return null;
		const texel = (Math.floor(z / 4) & 255) * 256 + (Math.floor(x / 4) & 255);
		const rgb = (layer: number): [number, number, number] => {
			const p = this.pixels[layer], i = texel * 4;
			return [p[i], p[i + 1], p[i + 2]];
		};
		return { biome: this.biomes[texel], grass: rgb(0), leaves: rgb(1), water: rgb(2) };
	}
}
