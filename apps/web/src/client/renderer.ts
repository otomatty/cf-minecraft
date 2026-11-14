// WebGPU renderer for chunk sections.
//
// Fidelity notes (what matches the game, what does not yet):
// * Colour maths happen in gamma space with nearest-neighbour magnification
//   and linear mip blending, like the original fixed pipeline.
// * Directional face shading 1.0 / 0.5 / 0.8 / 0.6 and the ambient occlusion
//   brightness steps are the game's values.
// * Per-block light levels and translucent blocks are not implemented yet.
//
// Precision: vertices are small integers relative to their section, and the
// section origin is subtracted from the camera's block position in integer
// arithmetic before anything becomes a float. Rendering stays exact at the
// world border.

import { skyState } from "./sky.ts";
import { MIN_Y, WORDS_PER_QUAD } from "./client-core.ts";
import { boxInFrustum, forward, right, frustumPlanes, viewProjection } from "./math.ts";
import { downsample, GRASS_TINT, paintTexture, paintSkyTexture, TEX_SIZE } from "./textures.ts";

const MAX_SECTIONS = 16384;
/** Worst case for one section: a 3D checkerboard, 2048 blocks with six faces each. */
const MAX_QUADS = 2048 * 6;
const GLOBALS_BYTES = 272;
const MIP_LEVELS = 5;

export const FOV_Y = 70;
const NEAR = 0.05;

const TERRAIN_WGSL = /* wgsl */ `
struct Globals {
	viewProj: mat4x4<f32>,
	camBlock: vec4<i32>,
	camFrac: vec4<f32>,
	fogColor: vec4<f32>,
	fogRange: vec4<f32>,
	grassTint: vec4<f32>,
	skyColor: vec4<f32>,
	sunset: vec4<f32>,
	celestial: vec4<f32>,
	forward: vec4<f32>,
	right: vec4<f32>,
	up: vec4<f32>,
	skyCamera: vec4<f32>,
	cloudOrigin: vec4<f32>,
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<storage, read> origins: array<vec4<i32>>;
@group(0) @binding(2) var tex: texture_2d_array<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) shade: f32,
	@location(2) rel: vec3<f32>,
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
	out.rel = rel;
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
	// #14 で置き換える: temporary global skylight until per-block lighting exists.
	color = color * in.shade * g.fogRange.z;
	let dist = max(length(in.rel.xz), abs(in.rel.y));
	let fog = smoothstep(g.fogRange.x, g.fogRange.y, dist);
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
	skyColor: vec4<f32>,
	sunset: vec4<f32>,
	celestial: vec4<f32>,
	forward: vec4<f32>,
	right: vec4<f32>,
	up: vec4<f32>,
	skyCamera: vec4<f32>,
	cloudOrigin: vec4<f32>,
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

// Fullscreen sky rays and a depth-tested cloud plane share the camera and fog uniforms.
const SKY_WGSL = TERRAIN_WGSL.slice(0, TERRAIN_WGSL.indexOf("@group(0) @binding(1)")) + /* wgsl */ `
@group(0) @binding(1) var art: texture_2d_array<f32>;
@group(0) @binding(2) var artSampler: sampler;
struct SkyOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) ray: vec3<f32>,
};
@vertex fn vsSky(@builtin(vertex_index) id: u32) -> SkyOut {
	let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
	var out: SkyOut;
	out.pos = vec4<f32>(p[id], 1.0, 1.0);
	out.ray = g.forward.xyz + g.right.xyz * p[id].x * g.skyCamera.x * g.skyCamera.y + g.up.xyz * p[id].y * g.skyCamera.x;
	return out;
}
// Integer hash with a fixed seed: stable world-space star positions on spherical cells.
fn hash(cell: vec2<u32>) -> u32 {
	var h = cell.x * 374761393u + cell.y * 668265263u + 10842u;
	h = (h ^ (h >> 13u)) * 1274126177u;
	return h ^ (h >> 16u);
}
fn body(ray: vec3<f32>, direction: vec3<f32>, tangent: vec3<f32>, size: f32, layer: i32) -> vec4<f32> {
	let facing = dot(ray, direction);
	let uv = vec2<f32>(dot(ray, vec3<f32>(0.0, 0.0, 1.0)), dot(ray, tangent)) / max(facing * size, 0.0001) * 0.5 + 0.5;
	let pixel = textureSampleLevel(art, artSampler, uv, layer, 0.0);
	if (facing <= 0.0 || any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return vec4<f32>(0.0); }
	return pixel;
}
@fragment fn fsSky(in: SkyOut) -> @location(0) vec4<f32> {
	let ray = normalize(in.ray);
	var color = mix(g.fogColor.rgb, g.skyColor.rgb, smoothstep(0.0, 0.45, ray.y));
	let a = g.celestial.x * 6.283185307;
	let sun = vec3<f32>(-sin(a), cos(a), 0.0);
	let tangent = vec3<f32>(cos(a), sin(a), 0.0);
	let horizon = exp(-abs(ray.y) * 12.0);
	let facing = max(0.0, ray.x * sign(sun.x));
	color = mix(color, g.sunset.rgb, g.sunset.a * horizon * facing * facing);
	// Rotate star coordinates with the same celestial angle as the sun and moon.
	let rotated = vec3<f32>(dot(ray.xy, vec2<f32>(cos(a), sin(a))), dot(ray.xy, vec2<f32>(-sin(a), cos(a))), ray.z);
	let coord = vec2<f32>(atan2(rotated.z, rotated.x) / 6.283185307 + 0.5, acos(clamp(rotated.y, -1.0, 1.0)) / 3.141592654) * vec2<f32>(512.0, 256.0);
	let cell = vec2<u32>(floor(coord));
	let seed = hash(cell);
	let offset = vec2<f32>(f32((seed >> 8u) & 255u), f32((seed >> 16u) & 255u)) / 255.0;
	let point = 1.0 - smoothstep(0.04, 0.18, length(fract(coord) - (0.2 + offset * 0.6)));
	if ((seed & 127u) == 0u) { color += vec3<f32>(point * g.celestial.y * smoothstep(0.0, 0.12, ray.y)); }
	let sunPixel = body(ray, sun, tangent, 0.13, 0);
	let moonPixel = body(ray, -sun, -tangent, 0.10, 1 + i32(g.celestial.z));
	let visible = smoothstep(-0.03, 0.03, ray.y);
	// Emissive bodies add light, like the stars above; they never darken the sky.
	color += sunPixel.rgb * sunPixel.a * visible;
	color += moonPixel.rgb * moonPixel.a * visible;
	return vec4<f32>(color, 1.0);
}
struct CloudOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) rel: vec3<f32>,
};
@vertex fn vsCloud(@builtin(vertex_index) id: u32) -> CloudOut {
	let corners = array<vec2<f32>, 6>(vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,-1.0), vec2<f32>(1.0,1.0), vec2<f32>(-1.0,-1.0), vec2<f32>(1.0,1.0), vec2<f32>(-1.0,1.0));
	var out: CloudOut;
	let p = corners[id] * g.cloudOrigin.w;
	out.rel = vec3<f32>(p.x, 192.0 - g.skyCamera.z, p.y);
	out.pos = g.viewProj * vec4<f32>(out.rel, 1.0);
	return out;
}
@fragment fn fsCloud(in: CloudOut) -> @location(0) vec4<f32> {
	let uv = (in.rel.xz + g.cloudOrigin.xy + vec2<f32>(g.skyCamera.w, 0.0)) / 256.0;
	let pixel = textureSampleLevel(art, artSampler, fract(uv), 9, 0.0);
	if (pixel.a < 0.1) { discard; }
	// Clouds extend beyond terrain: preserve nearby opacity, then fade into the sky.
	let fog = smoothstep(g.cloudOrigin.z, g.cloudOrigin.w, max(length(in.rel.xz), abs(in.rel.y)));
	let color = vec3<f32>(0.16 + g.skyColor.a * 0.84);
	return vec4<f32>(color, pixel.a * (1.0 - fog));
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
	skyBrightness: number;
}

const key = (cx: number, sy: number, cz: number) => `${cx},${sy},${cz}`;

export class Renderer {
	readonly adapterInfo: string;
	private readonly device: GPUDevice;
	private readonly context: GPUCanvasContext;
	private readonly canvas: HTMLCanvasElement;
	private readonly format: GPUTextureFormat;
	private readonly sky: GPURenderPipeline;
	private readonly clouds: GPURenderPipeline;
	private readonly skyBind: GPUBindGroup;
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

		const skyArt = device.createTexture({ size: [TEX_SIZE, TEX_SIZE, 10], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		for (let layer = 0; layer < 10; layer++) {
			device.queue.writeTexture({ texture: skyArt, origin: [0, 0, layer] }, paintSkyTexture(layer), { bytesPerRow: TEX_SIZE * 4 }, [TEX_SIZE, TEX_SIZE, 1]);
		}
		const skyModule = device.createShaderModule({ code: SKY_WGSL });
		const skyLayout = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
		] });
		const skyPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [skyLayout] });
		this.sky = device.createRenderPipeline({
			layout: skyPipelineLayout,
			vertex: { module: skyModule, entryPoint: "vsSky" },
			fragment: { module: skyModule, entryPoint: "fsSky", targets: [{ format: this.format }] },
			depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
		});
		this.clouds = device.createRenderPipeline({
			layout: skyPipelineLayout,
			vertex: { module: skyModule, entryPoint: "vsCloud" },
			fragment: { module: skyModule, entryPoint: "fsCloud", targets: [{ format: this.format, blend: {
				color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
				alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
			} }] },
			primitive: { cullMode: "none" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
		});
		this.skyBind = device.createBindGroup({ layout: skyLayout, entries: [
			{ binding: 0, resource: { buffer: this.globals } },
			{ binding: 1, resource: skyArt.createView({ dimension: "2d-array" }) },
			{ binding: 2, resource: sampler },
		] });

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
	 * `dayTime` includes the presentation-only partial tick from time packet arrivals.
	 */
	render(camera: Camera, viewDistance: number, target: readonly [number, number, number] | null, fovY = FOV_Y, dayTime = 6000): FrameStats {
		this.resize();
		const sky = skyState(dayTime, viewDistance);
		const cloudFogEnd = Math.max(256, viewDistance * 16 * 2);
		// Keep the cloud plane visible through its entire fade, including diagonal views.
		const far = Math.max((viewDistance + 2) * 16 * 2, cloudFogEnd * 2);
		const viewProj = viewProjection(camera.yaw, camera.pitch, fovY, this.canvas.width / this.canvas.height, NEAR, far);
		const block = [Math.floor(camera.x), Math.floor(camera.y), Math.floor(camera.z)];
		const frac = [camera.x - block[0], camera.y - block[1], camera.z - block[2]];

		const f = this.globalsF32;
		const i = this.globalsI32;
		f.set(viewProj, 0);
		i.set([block[0], block[1], block[2], 0], 16);
		f.set([frac[0], frac[1], frac[2], 0], 20);
		f.set([...sky.fogColor, 1], 24);
		const fogEnd = viewDistance * 16;
		f.set([fogEnd * 0.75, fogEnd, sky.skylight, 0], 28);
		f.set([GRASS_TINT[0] / 255, GRASS_TINT[1] / 255, GRASS_TINT[2] / 255, 1], 32);
		f.set([...sky.skyColor, sky.skyBrightness], 36);
		f.set([...sky.sunsetColor, sky.sunsetStrength], 40);
		f.set([sky.angle, sky.starBrightness, sky.moonPhase, 0], 44);
		const look = forward(camera.yaw, camera.pitch);
		const side = right(camera.yaw);
		const up = [side[1] * look[2] - side[2] * look[1], side[2] * look[0] - side[0] * look[2], side[0] * look[1] - side[1] * look[0]];
		f.set([...look, 0], 48);
		f.set([...side, 0], 52);
		f.set([...up, 0], 56);
		f.set([Math.tan(fovY * Math.PI / 360), this.canvas.width / this.canvas.height, camera.y, (dayTime * 0.015) % 256], 60);
		// xy: repeating cloud texture origin; zw: cloud-only cylindrical fog range.
		f.set([camera.x % 256, camera.z % 256, cloudFogEnd * 0.65, cloudFogEnd], 64);
		this.device.queue.writeBuffer(this.globals, 0, this.globalsData);

		if (target) {
			this.device.queue.writeBuffer(this.outlineVertices, 0, outlineBox(target, block, frac));
		}

		const encoder = this.device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: this.context.getCurrentTexture().createView(),
					clearValue: { r: sky.fogColor[0], g: sky.fogColor[1], b: sky.fogColor[2], a: 1 },
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

		// Sky -> additive stars/sun/moon, without writing depth; terrain occludes them.
		pass.setPipeline(this.sky);
		pass.setBindGroup(0, this.skyBind);
		pass.draw(3);

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

		// Alpha-blended clouds test terrain depth from either side, without writing it.
		pass.setPipeline(this.clouds);
		pass.setBindGroup(0, this.skyBind);
		pass.draw(6);

		if (target) {
			pass.setPipeline(this.outline);
			pass.setBindGroup(0, this.outlineBind);
			pass.setVertexBuffer(0, this.outlineVertices);
			pass.draw(24);
		}
		pass.end();
		this.device.queue.submit([encoder.finish()]);
		return { sections: this.sections.size, drawn, quads, skyBrightness: sky.skyBrightness };
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
