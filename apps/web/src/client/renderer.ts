// WebGPU renderer for chunk sections.
//
// Fidelity notes (what matches the game, what does not yet):
// * Colour maths happen in gamma space with nearest-neighbour magnification
//   and linear mip blending, like the original fixed pipeline.
// * Directional face shading 1.0 / 0.5 / 0.8 / 0.6 and the ambient occlusion
//   brightness steps are the game's values.
// * Light levels, the sky, clouds, day/night tint and translucent blocks are
//   not implemented (M1).
//
// Precision: vertices are small integers relative to their section, and the
// section origin is subtracted from the camera's block position in integer
// arithmetic before anything becomes a float. Rendering stays exact at the
// world border.

import { MIN_Y, WORDS_PER_QUAD } from "./client-core.ts";
import { boxInFrustum, frustumPlanes, viewProjection } from "./math.ts";
import { downsample, GRASS_TINT, paintTexture, TEX_SIZE } from "./textures.ts";

const MAX_SECTIONS = 16384;
/** Worst case for one section: a 3D checkerboard, 2048 blocks with six faces each. */
const MAX_QUADS = 2048 * 6;
const GLOBALS_BYTES = 144;
const MIP_LEVELS = 5;

export const FOV_Y = 70;
const NEAR = 0.05;
const FOG_COLOR = [0xc0 / 255, 0xd8 / 255, 0xff / 255] as const;

const TERRAIN_WGSL = /* wgsl */ `
struct Globals {
	viewProj: mat4x4<f32>,
	camBlock: vec4<i32>,
	camFrac: vec4<f32>,
	fogColor: vec4<f32>,
	fogRange: vec4<f32>,
	grassTint: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> origins: array<vec4<i32>>;
@group(0) @binding(2) var tex: texture_2d_array<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) shade: f32,
	@location(2) dist: f32,
	@location(3) @interpolate(flat) layer: u32,
	@location(4) @interpolate(flat) tint: u32,
};

@vertex
fn vs(@location(0) a: vec2<u32>, @builtin(instance_index) section: u32) -> VOut {
	let local = vec3<f32>(f32(a.x & 31u), f32((a.x >> 5u) & 31u), f32((a.x >> 10u) & 31u));
	let face = (a.x >> 15u) & 7u;
	let ao = (a.x >> 18u) & 3u;
	let rel = vec3<f32>(origins[section].xyz - g.camBlock.xyz) + local - g.camFrac.xyz;

	// Direction order: down, up, north, south, west, east.
	var faceShade = array<f32, 6>(0.5, 1.0, 0.8, 0.8, 0.6, 0.6);
	var aoShade = array<f32, 4>(0.4, 0.6, 0.8, 1.0);

	var out: VOut;
	out.pos = g.viewProj * vec4<f32>(rel, 1.0);
	out.uv = vec2<f32>(f32((a.x >> 20u) & 1u), f32((a.x >> 21u) & 1u));
	out.shade = faceShade[face] * aoShade[ao];
	out.dist = length(rel);
	out.layer = a.y & 4095u;
	out.tint = (a.y >> 12u) & 1u;
	return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
	var color = textureSample(tex, samp, in.uv, in.layer).rgb;
	if (in.tint == 1u) {
		color = color * g.grassTint.rgb;
	}
	color = color * in.shade;
	let fog = clamp((in.dist - g.fogRange.x) / (g.fogRange.y - g.fogRange.x), 0.0, 1.0);
	return vec4<f32>(mix(color, g.fogColor.rgb, fog), 1.0);
}
`;

const OUTLINE_WGSL = /* wgsl */ `
struct Globals {
	viewProj: mat4x4<f32>,
	camBlock: vec4<i32>,
	camFrac: vec4<f32>,
	fogColor: vec4<f32>,
	fogRange: vec4<f32>,
	grassTint: vec4<f32>,
};
@group(0) @binding(0) var<uniform> g: Globals;

@vertex
fn vs(@location(0) rel: vec3<f32>) -> @builtin(position) vec4<f32> {
	return g.viewProj * vec4<f32>(rel, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
	return vec4<f32>(0.0, 0.0, 0.0, 0.4);
}
`;

interface SectionMesh {
	slot: number;
	buffer: GPUBuffer;
	quads: number;
	cx: number;
	sy: number;
	cz: number;
}

export interface Camera {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

export interface FrameStats {
	sections: number;
	drawn: number;
	quads: number;
}

const key = (cx: number, sy: number, cz: number) => `${cx},${sy},${cz}`;

export class Renderer {
	readonly adapterInfo: string;
	private readonly device: GPUDevice;
	private readonly context: GPUCanvasContext;
	private readonly canvas: HTMLCanvasElement;
	private readonly format: GPUTextureFormat;
	private readonly terrain: GPURenderPipeline;
	private readonly outline: GPURenderPipeline;
	private readonly globals: GPUBuffer;
	private readonly origins: GPUBuffer;
	private readonly quadIndices: GPUBuffer;
	private readonly outlineVertices: GPUBuffer;
	private readonly terrainBind: GPUBindGroup;
	private readonly outlineBind: GPUBindGroup;
	private depth: GPUTexture | null = null;
	private readonly sections = new Map<string, SectionMesh>();
	private readonly freeSlots: number[] = [];
	private nextSlot = 0;
	private readonly globalsData = new ArrayBuffer(GLOBALS_BYTES);
	private readonly globalsF32 = new Float32Array(this.globalsData);
	private readonly globalsI32 = new Int32Array(this.globalsData);
	/** Pixels of every texture layer, for UI thumbnails. */
	readonly texturePixels = new Map<string, Uint8Array>();
	lost: string | null = null;

	private constructor(canvas: HTMLCanvasElement, device: GPUDevice, adapterInfo: string, textureNames: string[]) {
		this.canvas = canvas;
		this.device = device;
		this.adapterInfo = adapterInfo;
		this.context = canvas.getContext("webgpu") as GPUCanvasContext;
		this.format = navigator.gpu.getPreferredCanvasFormat();
		this.context.configure({ device, format: this.format, alphaMode: "opaque" });
		device.lost.then((info) => {
			this.lost = info.message || "GPU device lost";
		});
		// Validation errors are otherwise silent: surface them in the console.
		device.addEventListener("uncapturederror", (event) => {
			console.error(`WebGPU: ${event.error.message}`);
		});

		this.globals = device.createBuffer({ size: GLOBALS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		this.origins = device.createBuffer({ size: MAX_SECTIONS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.outlineVertices = device.createBuffer({ size: 24 * 12, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

		// Every quad uses the same two triangles, so one index buffer serves all sections.
		const indices = new Uint32Array(MAX_QUADS * 6);
		for (let q = 0; q < MAX_QUADS; q++) {
			indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
		}
		this.quadIndices = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(this.quadIndices, 0, indices);

		const texture = device.createTexture({
			size: [TEX_SIZE, TEX_SIZE, Math.max(2, textureNames.length)],
			format: "rgba8unorm",
			mipLevelCount: MIP_LEVELS,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		textureNames.forEach((name, layer) => {
			let pixels = paintTexture(name);
			this.texturePixels.set(name, pixels);
			for (let level = 0, size = TEX_SIZE; level < MIP_LEVELS; level++, size >>= 1) {
				device.queue.writeTexture(
					{ texture, mipLevel: level, origin: [0, 0, layer] },
					pixels,
					{ bytesPerRow: size * 4 },
					[size, size, 1],
				);
				if (size > 1) pixels = downsample(pixels, size);
			}
		});
		const sampler = device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			mipmapFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});

		const terrainModule = device.createShaderModule({ code: TERRAIN_WGSL });
		this.terrain = device.createRenderPipeline({
			layout: "auto",
			vertex: {
				module: terrainModule,
				entryPoint: "vs",
				buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "uint32x2" }] }],
			},
			fragment: { module: terrainModule, entryPoint: "fs", targets: [{ format: this.format }] },
			primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
		});
		this.terrainBind = device.createBindGroup({
			layout: this.terrain.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.globals } },
				{ binding: 1, resource: { buffer: this.origins } },
				{ binding: 2, resource: texture.createView({ dimension: "2d-array" }) },
				{ binding: 3, resource: sampler },
			],
		});

		const outlineModule = device.createShaderModule({ code: OUTLINE_WGSL });
		this.outline = device.createRenderPipeline({
			layout: "auto",
			vertex: {
				module: outlineModule,
				entryPoint: "vs",
				buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
			},
			fragment: {
				module: outlineModule,
				entryPoint: "fs",
				targets: [
					{
						format: this.format,
						blend: {
							color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
						},
					},
				],
			},
			primitive: { topology: "line-list" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
		});
		this.outlineBind = device.createBindGroup({
			layout: this.outline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: { buffer: this.globals } }],
		});
	}

	static async create(canvas: HTMLCanvasElement, textureNames: string[]): Promise<Renderer> {
		if (!("gpu" in navigator)) {
			throw new Error("このブラウザはWebGPUに対応していません。最新のChrome、Edge、Safari、Firefoxをお試しください。");
		}
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
		if (!adapter) throw new Error("WebGPUアダプターを取得できませんでした。");
		const device = await adapter.requestDevice();
		const info = adapter.info;
		const label = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "unknown adapter";
		return new Renderer(canvas, device, label, textureNames);
	}

	/** Replaces (or removes, when empty) the mesh of one section. */
	setSection(cx: number, sy: number, cz: number, words: Uint32Array): void {
		const k = key(cx, sy, cz);
		const old = this.sections.get(k);
		const quads = Math.min(words.length / WORDS_PER_QUAD, MAX_QUADS);
		if (quads === 0) {
			if (old) this.dropSection(k, old);
			return;
		}
		const byteLength = quads * WORDS_PER_QUAD * 4;
		const buffer = this.device.createBuffer({ size: byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		this.device.queue.writeBuffer(buffer, 0, words.buffer, words.byteOffset, byteLength);

		let slot: number;
		if (old) {
			slot = old.slot;
			old.buffer.destroy();
		} else {
			const free = this.freeSlots.pop();
			if (free !== undefined) slot = free;
			else if (this.nextSlot < MAX_SECTIONS) slot = this.nextSlot++;
			else {
				buffer.destroy();
				return;
			}
			this.device.queue.writeBuffer(this.origins, slot * 16, new Int32Array([cx * 16, MIN_Y + sy * 16, cz * 16, 0]));
		}
		this.sections.set(k, { slot, buffer, quads, cx, sy, cz });
	}

	private dropSection(k: string, mesh: SectionMesh): void {
		mesh.buffer.destroy();
		this.freeSlots.push(mesh.slot);
		this.sections.delete(k);
	}

	removeChunk(cx: number, cz: number): void {
		for (const [k, mesh] of this.sections) {
			if (mesh.cx === cx && mesh.cz === cz) this.dropSection(k, mesh);
		}
	}

	private resize(): void {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
		const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== width || this.canvas.height !== height || !this.depth) {
			this.canvas.width = width;
			this.canvas.height = height;
			this.depth?.destroy();
			this.depth = this.device.createTexture({
				size: [width, height],
				format: "depth24plus",
				usage: GPUTextureUsage.RENDER_ATTACHMENT,
			});
		}
	}

	/**
	 * Draws one frame. `target` is the block to outline, if any.
	 * `viewDistance` is in chunks and drives fog and the far plane.
	 */
	render(camera: Camera, viewDistance: number, target: readonly [number, number, number] | null, fovY = FOV_Y): FrameStats {
		this.resize();
		const far = (viewDistance + 2) * 16 * 2;
		const viewProj = viewProjection(camera.yaw, camera.pitch, fovY, this.canvas.width / this.canvas.height, NEAR, far);
		const block = [Math.floor(camera.x), Math.floor(camera.y), Math.floor(camera.z)];
		const frac = [camera.x - block[0], camera.y - block[1], camera.z - block[2]];

		const f = this.globalsF32;
		const i = this.globalsI32;
		f.set(viewProj, 0);
		i.set([block[0], block[1], block[2], 0], 16);
		f.set([frac[0], frac[1], frac[2], 0], 20);
		f.set([FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1], 24);
		const fogEnd = viewDistance * 16;
		f.set([fogEnd * 0.75, fogEnd, 0, 0], 28);
		f.set([GRASS_TINT[0] / 255, GRASS_TINT[1] / 255, GRASS_TINT[2] / 255, 1], 32);
		this.device.queue.writeBuffer(this.globals, 0, this.globalsData);

		if (target) {
			this.device.queue.writeBuffer(this.outlineVertices, 0, outlineBox(target, block, frac));
		}

		const encoder = this.device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: this.context.getCurrentTexture().createView(),
					clearValue: { r: FOG_COLOR[0], g: FOG_COLOR[1], b: FOG_COLOR[2], a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
			depthStencilAttachment: {
				view: this.depth!.createView(),
				depthClearValue: 1,
				depthLoadOp: "clear",
				depthStoreOp: "store",
			},
		});

		const planes = frustumPlanes(viewProj);
		let drawn = 0;
		let quads = 0;
		pass.setPipeline(this.terrain);
		pass.setBindGroup(0, this.terrainBind);
		pass.setIndexBuffer(this.quadIndices, "uint32");
		for (const mesh of this.sections.values()) {
			const x = mesh.cx * 16 - block[0] - frac[0];
			const y = MIN_Y + mesh.sy * 16 - block[1] - frac[1];
			const z = mesh.cz * 16 - block[2] - frac[2];
			if (!boxInFrustum(planes, x, y, z, 16)) continue;
			pass.setVertexBuffer(0, mesh.buffer);
			// The instance index doubles as the section's slot in the origin table.
			pass.drawIndexed(mesh.quads * 6, 1, 0, 0, mesh.slot);
			drawn++;
			quads += mesh.quads;
		}

		if (target) {
			pass.setPipeline(this.outline);
			pass.setBindGroup(0, this.outlineBind);
			pass.setVertexBuffer(0, this.outlineVertices);
			pass.draw(24);
		}
		pass.end();
		this.device.queue.submit([encoder.finish()]);
		return { sections: this.sections.size, drawn, quads };
	}
}

/** The twelve edges of a slightly enlarged unit cube around a block, relative to the camera. */
function outlineBox(target: readonly [number, number, number], block: number[], frac: number[]): Float32Array<ArrayBuffer> {
	const e = 0.002;
	const lo = [0, 1, 2].map((a) => target[a] - block[a] - frac[a] - e);
	const hi = lo.map((v) => v + 1 + 2 * e);
	const corner = (n: number) => [n & 1 ? hi[0] : lo[0], n & 2 ? hi[1] : lo[1], n & 4 ? hi[2] : lo[2]];
	const edges = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
	const out = new Float32Array(24 * 3);
	edges.forEach((n, i) => out.set(corner(n), i * 3));
	return out;
}
