import { digVertices, type RenderDig } from "./dig.ts";
// WebGPU renderer for chunk sections.
//
// Fidelity notes (what matches the game, what does not yet):
// * Colour maths happen in gamma space with nearest-neighbour magnification
//   and linear mip blending, like the original fixed pipeline.
// * Directional face shading 1.0 / 0.5 / 0.8 / 0.6 and the ambient occlusion
//   brightness steps are the game's values.
// * Per-vertex sky/block light samples a time-dependent lightmap.
//
// Precision: vertices are small integers relative to their section, and the
// section origin is subtracted from the camera's block position in integer
// arithmetic before anything becomes a float. Rendering stays exact at the
// world border.

import { entitySkins, explosionVertices, flameVertices, itemVertices, limitRenderItems, MAX_EXPLOSION_PARTICLES, MAX_RENDER_ITEMS, MOB_SKIN_SIZE, mobInFrustum, mobVertices, type ExplosionParticle, type RenderItem, type RenderMob, type RenderPlayer, type RenderSprite } from "./entities.ts";
import { blastFrames, smokeFrames } from "./mobs/explosion.ts";
import { flameFrames } from "./mobs/flame.ts";
import type { TintRect } from "./tint-map.ts";
import { quadCenters, sortSections, sortedQuadIndices, splitMeshLayers, updateTranslucentSort, type LayerCounts, type Point } from "./mesh-layers.ts";
import { skyState, lightmap } from "./sky.ts";
import { type RayHit, MIN_Y, WORDS_PER_QUAD } from "./client-core.ts";
import { boxInFrustum, forward, right, frustumPlanes, viewProjection, type Vec3 } from "./math.ts";
import { paintCracks, downsample, paintTexture, paintSkyTexture, TEX_SIZE } from "./textures.ts";
import { fluidFrame, FLUID_FRAMES, grassSideAtlasPixels } from "./block-textures.ts";
import { hasItemTexture } from "./item-textures.ts";
import type { PlayerNames } from "./player-names.ts";

const MAX_SECTIONS = 16384;
/** A fence has a post and up to eight rails, with six faces per box. */
const MAX_QUADS = 4096 * 54;
const GLOBALS_BYTES = 272;
const MIP_LEVELS = 5;

export const FOV_Y = 70;
const NEAR = 0.05;
export const CLOUD_HEIGHT = 192;

/** Below the cloud plane, water must blend over clouds already drawn behind it. */
export function cloudsBeforeTranslucent(cameraY: number, cloudHeight = CLOUD_HEIGHT): boolean {
	return cameraY < cloudHeight;
}

const TERRAIN_WGSL = /* wgsl */ `
struct Globals {
	viewProj: mat4x4<f32>,
	camBlock: vec4<i32>,
	camFrac: vec4<f32>,
	fogColor: vec4<f32>,
	fogRange: vec4<f32>,
	fluidLayers: vec4<u32>,
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
@group(0) @binding(4) var lightTex: texture_2d<f32>;
@group(0) @binding(5) var lightSampler: sampler;
@group(0) @binding(6) var tintTex: texture_2d_array<f32>;
@group(0) @binding(7) var tintSampler: sampler;

struct VOut {
	@builtin(position) pos: vec4<f32>,
	@location(0) uv: vec2<f32>,
	@location(1) shade: f32,
	@location(2) rel: vec3<f32>,
	@location(3) @interpolate(flat) layer: u32,
	@location(4) @interpolate(perspective, center) tintColor: vec3<f32>,
	@location(5) light: vec2<f32>,
};

// Recover the owning cube from its face and unrotated UV, so all four vertices
// choose the same turn, including faces on section boundaries and at negative coordinates.
fn rotatedBlockUV(world: vec3<i32>, face: u32, uv: vec2<f32>) -> vec2<f32> {
	var corner: vec3<f32>;
	switch face {
		case 0u: { corner = vec3<f32>(uv.x, 0.0, 1.0 - uv.y); }
		case 1u: { corner = vec3<f32>(uv.x, 1.0, uv.y); }
		case 2u: { corner = vec3<f32>(1.0 - uv.x, 1.0 - uv.y, 0.0); }
		case 3u: { corner = vec3<f32>(uv.x, 1.0 - uv.y, 1.0); }
		case 4u: { corner = vec3<f32>(0.0, 1.0 - uv.y, uv.x); }
		default: { corner = vec3<f32>(1.0, 1.0 - uv.y, 1.0 - uv.x); }
	}
	let p = bitcast<vec3<u32>>(world - vec3<i32>(corner));
	let seed = (p.x * 374761393u) ^ (p.y * 668265263u) ^ (p.z * 2246822519u) ^ face;
	switch (((seed ^ (seed >> 13u)) * 1274126177u) >> 30u) {
		case 1u: { return vec2<f32>(1.0 - uv.y, uv.x); }
		case 2u: { return vec2<f32>(1.0) - uv; }
		case 3u: { return vec2<f32>(uv.y, 1.0 - uv.x); }
		default: { return uv; }
	}
}

@vertex
fn vs(@location(0) a: vec2<u32>, @builtin(instance_index) section: u32) -> VOut {
	var local = vec3<f32>(f32(a.x & 511u), f32((a.x >> 9u) & 511u), f32((a.x >> 18u) & 511u)) / 16.0;
	local.y -= f32(a.y >> 31u) / 9.0;
	let face = (a.x >> 27u) & 7u;
	let ao = (a.x >> 30u) & 3u;
	let rel = vec3<f32>(origins[section].xyz - g.camBlock.xyz) + local - g.camFrac.xyz;

	// Direction order: down, up, north, south, west, east.
	var faceShade = array<f32, 6>(0.5, 1.0, 0.8, 0.8, 0.6, 0.6);
	var aoShade = array<f32, 4>(0.4, 0.6, 0.8, 1.0);

	var out: VOut;
	out.pos = g.viewProj * vec4<f32>(rel, 1.0);
	out.uv = vec2<f32>(f32((a.y >> 21u) & 31u), f32((a.y >> 26u) & 31u)) / 16.0;
	// Crop water side UVs at the displaced height, including a strip's lower edge.
	if (face >= 2u) { out.uv.y += f32(a.y >> 31u) / 9.0; }
	out.shade = faceShade[face] * aoShade[ao];
	out.rel = rel;
	out.layer = a.y & 4095u;
	if (__ISOTROPIC_FACE__) {
		out.uv = rotatedBlockUV(origins[section].xyz + vec3<i32>(local), face, out.uv);
	}
	if (out.layer == __LAVA_LAYER__u) { out.layer = g.fluidLayers.z; }
	else if (out.layer == __LAVA_FLOW_LAYER__u) { out.layer = g.fluidLayers.w; }
	out.tintColor = vec3<f32>(1.0);
	if (((a.y >> 12u) & 1u) == 1u) {
		var tintLayer = 0;
		if (__LEAVES_LAYERS__) { tintLayer = 1; }
		if (out.layer == __WATER_LAYER__u || out.layer == __FLOW_LAYER__u) {
			tintLayer = 2;
			out.layer = select(g.fluidLayers.x, g.fluidLayers.y, out.layer == __FLOW_LAYER__u);
		}
		let worldXZ = vec2<f32>(origins[section].xz & vec2<i32>(1023)) + local.xz;
		let uv = worldXZ / 4.0 / 256.0;
		let step = 1.0 / 256.0;
		out.tintColor = (
			textureSampleLevel(tintTex, tintSampler, uv + vec2<f32>(-step, -step), tintLayer, 0.0).rgb +
			textureSampleLevel(tintTex, tintSampler, uv + vec2<f32>(step, -step), tintLayer, 0.0).rgb +
			textureSampleLevel(tintTex, tintSampler, uv + vec2<f32>(-step, step), tintLayer, 0.0).rgb +
			textureSampleLevel(tintTex, tintSampler, uv + vec2<f32>(step, step), tintLayer, 0.0).rgb
		) * 0.25;
	}
	out.light = (vec2<f32>(f32((a.y >> 17u) & 15u), f32((a.y >> 13u) & 15u)) + vec2<f32>(0.5)) / 16.0;
	return out;
}

override renderLayer: u32 = 0u;
// 0 = terrain, 1 = drops, 2 = mob skins, 3 = flames and explosion particles, 4 = mining overlays.
override entityPass: u32 = 0u;

@vertex
fn vsEntity(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) shade: f32, @location(3) layer: f32, @location(4) light: vec2<f32>) -> VOut {
	var out: VOut;
	out.pos = g.viewProj * vec4<f32>(pos, 1.0);
	out.rel = pos;
	out.uv = uv;
	out.shade = shade;
	out.layer = u32(layer);
	out.light = light;
	out.tintColor = vec3<f32>(1.0);
	return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
	let pixel = textureSample(tex, samp, in.uv, in.layer);
	// Unmarked texels are white. Multiply the already lit block by the crack mask.
	if (entityPass == 4u) { return vec4<f32>(mix(vec3<f32>(1.0), pixel.rgb, pixel.a), 1.0); }
	var color = pixel.rgb;
	var shade = in.shade;
	if (entityPass == 2u) {
		// |shade| above 1.5 is the creeper's white flash, stacked on the red hurt tint.
		if (abs(shade) > 1.5) {
			color = mix(color, vec3<f32>(1.0), 0.5);
			shade = shade - sign(shade) * 2.0;
		}
		if (shade < 0.0) { color = mix(color, vec3<f32>(1.0, 0.12, 0.12), 0.5); }
	} else if (in.layer == __GRASS_SIDE_LAYER__u) {
		// RGB carries bare soil; alpha carries the turf's grayscale intensity.
		color += pixel.a * in.tintColor;
	} else {
		color = color * in.tintColor;
	}
	if (entityPass != 3u) {
		color = color * abs(shade) * textureSample(lightTex, lightSampler, in.light).rgb;
	}
	if (renderLayer == 1u && select(pixel.a < 0.5, __DROP_ALPHA_TEST__, entityPass == 1u)) { discard; }
	let dist = max(length(in.rel.xz), abs(in.rel.y));
	let fog = smoothstep(g.fogRange.x, g.fogRange.y, dist);
	return vec4<f32>(mix(color, g.fogColor.rgb, fog), select(1.0, pixel.a, renderLayer == 2u));
}
`;

/** Resolve tint layers from the same ordered names used to upload the texture array. */
export function terrainShader(textureNames: readonly string[]): string {
	const matches = (names: string[]) => textureNames.flatMap((name, layer) =>
		names.includes(name) ? [`out.layer == ${layer}u`] : []).join(" || ") || "false";
	// Bedrock's blocks.json marks these cube faces as isotropic.
	const allFaces = matches(["dirt", "coarse_dirt", "sand", "snow_block"]);
	const leaves = ["oak_leaves", "oak_leaves_dense"];
	const caps = matches(["grass_block_top", "sandstone_top", "sandstone_bottom", ...leaves]);
	// Missing names use an impossible packed texture index rather than tinting layer zero.
	return TERRAIN_WGSL
		.replace("__ISOTROPIC_FACE__", `${allFaces} || (face <= 1u && (${caps}))`)
		.replace("__GRASS_SIDE_LAYER__", String(textureNames.indexOf("grass_block_side") >>> 0))
		.replace("__DROP_ALPHA_TEST__", dropAlphaTest(textureNames))
		.replace("__LEAVES_LAYERS__", matches(leaves))
		.replaceAll("__FLOW_LAYER__", String(textureNames.indexOf("water_flow") >>> 0))
		.replace("__LAVA_FLOW_LAYER__", String(textureNames.indexOf("lava_flow") >>> 0))
		.replace("__LAVA_LAYER__", String(textureNames.indexOf("lava") >>> 0))
		.replace("__WATER_LAYER__", String(textureNames.indexOf("water") >>> 0));
}

const cutoutBlockTextures = new Set([
	"glass", "oak_leaves", "oak_leaves_dense", "red_flower", "yellow_flower", "short_grass",
	"wheat_sprout", "wheat_stage_1", "wheat_shoot", "wheat_stage_3", "wheat_stage_4", "wheat_green", "wheat_stage_6", "wheat_ripe",
]);

export function usesCutoutMips(name: string): boolean {
	return hasItemTexture(name) || cutoutBlockTextures.has(name);
}

/** Group adjacent sprite layers into a single shader comparison per range. */
export function dropAlphaTest(textureNames: readonly string[]): string {
	const ranges: string[] = [];
	for (let layer = 0; layer < textureNames.length; layer++) {
		if (!hasItemTexture(textureNames[layer])) continue;
		const first = layer;
		while (layer + 1 < textureNames.length && hasItemTexture(textureNames[layer + 1])) layer++;
		ranges.push(`(in.layer >= ${first}u && in.layer <= ${layer}u)`);
	}
	return ranges.length
		? `(pixel.a <= 0.0 || (pixel.a < 0.5 && (${ranges.join(" || ")})))`
		: "pixel.a <= 0.0";
}

const OUTLINE_WGSL = /* wgsl */ `
struct Globals {
	viewProj: mat4x4<f32>,
	camBlock: vec4<i32>,
	camFrac: vec4<f32>,
	fogColor: vec4<f32>,
	fogRange: vec4<f32>,
	fluidLayers: vec4<u32>,
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
	out.rel = vec3<f32>(p.x, ${CLOUD_HEIGHT.toFixed(1)} - g.skyCamera.z, p.y);
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
	counts: LayerCounts;
	origin: Point;
	centers: Float32Array;
	translucentIndices: GPUBuffer | null;
	sortedAt: string;
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

/** Shared by all terrain layers and translucent sorting. null disables culling. */
export function filterVisibleSections<T>(sections: ReadonlyMap<string, T>, visible: ReadonlySet<string> | null): T[] {
	const result: T[] = [];
	for (const [k, mesh] of sections) {
		if (visible === null || visible.has(k)) result.push(mesh);
	}
	return result;
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
	private readonly items: GPURenderPipeline;
	private readonly mobs: GPURenderPipeline;
	private readonly flames: GPURenderPipeline;
	private readonly cracks: GPURenderPipeline;
	private readonly crackBuffer: GPUBuffer;
	private readonly crackTextureBase: number;
	private readonly itemBuffer: GPUBuffer;
	private mobBuffer: GPUBuffer | null = null;
	private readonly mobBind: GPUBindGroup;
	private readonly playerNames: PlayerNames;
	private readonly cutout: GPURenderPipeline;
	private readonly translucent: GPURenderPipeline;
	private readonly outline: GPURenderPipeline;
	private readonly globals: GPUBuffer;
	private readonly origins: GPUBuffer;
	private readonly quadIndices: GPUBuffer;
	private readonly quadIndexData: Uint32Array<ArrayBuffer>;
	private readonly outlineVertices: GPUBuffer;
	private readonly terrainBind: GPUBindGroup;
	private readonly lightTexture: GPUTexture;
	private readonly tintTexture: GPUTexture;
	private readonly outlineBind: GPUBindGroup;
	private depth: GPUTexture | null = null;
	visibleSections: ReadonlySet<string> | null = null;
	private readonly sections = new Map<string, SectionMesh>();
	private readonly freeSlots: number[] = [];
	private nextSlot = 0;
	private readonly globalsData = new ArrayBuffer(GLOBALS_BYTES);
	private readonly globalsF32 = new Float32Array(this.globalsData);
	private readonly globalsI32 = new Int32Array(this.globalsData);
	private readonly firstWaterFrame: number;
	private readonly firstLavaFrame: number;
	private readonly firstFlameFrame: number;
	private readonly firstExplosionFrame: number;
	/** Pixels of every texture layer, for UI thumbnails. */
	readonly texturePixels = new Map<string, Uint8Array>();
	lost: string | null = null;

	private readonly heldItemTextures: ReadonlyMap<string, number>;

	private constructor(canvas: HTMLCanvasElement, device: GPUDevice, adapterInfo: string, textureNames: string[], playerNames: PlayerNames, skins: ImageBitmap[]) {
		this.playerNames = playerNames;
		this.heldItemTextures = new Map(textureNames.map((name, index) => [name, index]));
		this.crackTextureBase = textureNames.length;
		textureNames = [...textureNames, ...Array.from({ length: 10 }, (_, i) => "crack_" + i)];
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
		this.quadIndexData = indices;
		this.quadIndices = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(this.quadIndices, 0, indices);

		this.firstWaterFrame = textureNames.length;
		const cutouts = new Set<number>();
		const tiles = textureNames.map((name, layer) => {
			const pixels = name.startsWith("crack_") ? paintCracks(Number(name.slice(6))) : paintTexture(name);
			this.texturePixels.set(name, pixels);
			if (usesCutoutMips(name)) cutouts.add(layer);
			return name === "grass_block_side" ? grassSideAtlasPixels() : pixels;
		});
		if (textureNames.includes("water") || textureNames.includes("water_flow")) {
			for (const name of ["water", "water_flow"] as const) {
				for (let frame = 0; frame < FLUID_FRAMES[name]; frame++) tiles.push(fluidFrame(name, frame));
			}
		}
		this.firstLavaFrame = tiles.length;
		if (textureNames.includes("lava") || textureNames.includes("lava_flow")) {
			for (const name of ["lava", "lava_flow"] as const) {
				for (let frame = 0; frame < FLUID_FRAMES[name]; frame++) tiles.push(fluidFrame(name, frame));
			}
		}
		this.firstFlameFrame = tiles.length;
		for (const pixels of flameFrames) {
			cutouts.add(tiles.length);
			tiles.push(pixels);
		}
		this.firstExplosionFrame = tiles.length;
		for (const pixels of [...blastFrames, ...smokeFrames]) {
			cutouts.add(tiles.length);
			tiles.push(pixels);
		}
		const texture = device.createTexture({
			size: [TEX_SIZE, TEX_SIZE, Math.max(2, tiles.length)],
			format: "rgba8unorm",
			mipLevelCount: MIP_LEVELS,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		// Upload the entire array in five writes, including the animation frames.
		for (let level = 0, size = TEX_SIZE; level < MIP_LEVELS && tiles.length; level++, size >>= 1) {
			const tileBytes = size * size * 4;
			const mip = new Uint8Array(tiles.length * tileBytes);
			tiles.forEach((pixels, layer) => {
				mip.set(pixels, layer * tileBytes);
				if (size > 1) tiles[layer] = downsample(pixels, size, cutouts.has(layer));
			});
			device.queue.writeTexture({ texture, mipLevel: level }, mip,
				{ bytesPerRow: size * 4, rowsPerImage: size }, [size, size, tiles.length]);
		}
		const sampler = device.createSampler({
			magFilter: "nearest",
			minFilter: "nearest",
			mipmapFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
		// Keep each UV island at native resolution, including the chicken's half-height skin.
		const mobSkins = device.createTexture({
			size: [MOB_SKIN_SIZE, MOB_SKIN_SIZE, entitySkins.length], format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
		});
		for (const [layer, skin] of skins.entries()) {
			device.queue.copyExternalImageToTexture({ source: skin }, { texture: mobSkins, origin: [0, 0, layer] },
				[skin.width, skin.height]);
		}

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

		const terrainModule = device.createShaderModule({ code: terrainShader(textureNames) });
		// Explicit shared layout permits the same bind group in all three pipelines.
		const terrainLayout = device.createBindGroupLayout({ entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
			{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
			{ binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
			{ binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			{ binding: 6, visibility: GPUShaderStage.VERTEX, texture: { viewDimension: "2d-array" } },
			{ binding: 7, visibility: GPUShaderStage.VERTEX, sampler: {} },
		] });
		const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [terrainLayout] });
		const terrainPipeline = (layer: number) => device.createRenderPipeline({
			layout: pipelineLayout,
			vertex: {
				module: terrainModule, entryPoint: "vs",
				buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "uint32x2" }] }],
			},
			fragment: { module: terrainModule, entryPoint: "fs", constants: { renderLayer: layer }, targets: [{
				format: this.format,
				...(layer === 2 ? { blend: {
					color: { srcFactor: "src-alpha" as const, dstFactor: "one-minus-src-alpha" as const },
					alpha: { srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const },
				} } : {}),
			}] },
			primitive: { topology: "triangle-list", cullMode: layer === 2 ? "none" : "back", frontFace: "ccw" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: layer !== 2, depthCompare: "less" },
		});
		const entityPipeline = (kind: "drops" | "cracks" | "mobs" | "flames"): GPURenderPipeline => device.createRenderPipeline({
			layout: pipelineLayout,
			vertex: {
				module: terrainModule, entryPoint: "vsEntity",
				buffers: [{ arrayStride: 36, attributes: [
					{ shaderLocation: 0, offset: 0, format: "float32x3" },
					{ shaderLocation: 1, offset: 12, format: "float32x2" },
					{ shaderLocation: 2, offset: 20, format: "float32" },
					{ shaderLocation: 3, offset: 24, format: "float32" },
					{ shaderLocation: 4, offset: 28, format: "float32x2" },
				] }],
			},
			fragment: {
				module: terrainModule, entryPoint: "fs",
				constants: { renderLayer: kind === "cracks" ? 2 : 1, entityPass: kind === "cracks" ? 4 : kind === "flames" ? 3 : kind === "mobs" ? 2 : 1 },
				targets: [{
					format: this.format,
					...(kind === "cracks" ? { blend: {
						color: { srcFactor: "dst" as const, dstFactor: "zero" as const },
						alpha: { srcFactor: "zero" as const, dstFactor: "one" as const },
					} } : {}),
				}],
			},
			// Bedrock cutout skins can put a leg or a rib on just one face of its box.
			primitive: { topology: "triangle-list", cullMode: kind === "mobs" ? "none" : "back", frontFace: "ccw" },
			depthStencil: { format: "depth24plus", depthWriteEnabled: kind !== "cracks", depthCompare: "less" },
		});
		this.items = entityPipeline("drops");
		this.cracks = entityPipeline("cracks");
		this.mobs = entityPipeline("mobs");
		this.flames = entityPipeline("flames");
		this.crackBuffer = device.createBuffer({ size: MAX_RENDER_ITEMS * 36 * 36, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		// Each drop uses up to 36 vertices, each burning mob two double-sided quads, and each particle one.
		const itemVerticesCapacity = MAX_RENDER_ITEMS * (36 + 24) + MAX_EXPLOSION_PARTICLES * 12;
		this.itemBuffer = device.createBuffer({ size: itemVerticesCapacity * 36, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		this.terrain = terrainPipeline(0);
		this.cutout = terrainPipeline(1);
		this.translucent = terrainPipeline(2);
		this.lightTexture = device.createTexture({ size: [16, 16], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		this.tintTexture = device.createTexture({ size: [256, 256, 3], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		const lightSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
		const tintSampler = device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", minFilter: "linear", magFilter: "linear" });
		const bindAtlas = (atlas: GPUTexture) => device.createBindGroup({
			layout: terrainLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.globals } },
				{ binding: 1, resource: { buffer: this.origins } },
				{ binding: 2, resource: atlas.createView({ dimension: "2d-array" }) },
				{ binding: 3, resource: sampler },
				{ binding: 4, resource: this.lightTexture.createView() },
				{ binding: 5, resource: lightSampler },
				{ binding: 6, resource: this.tintTexture.createView({ dimension: "2d-array" }) },
				{ binding: 7, resource: tintSampler },
			],
		});
		this.terrainBind = bindAtlas(texture);
		this.mobBind = bindAtlas(mobSkins);

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

	writeTints(rects: readonly TintRect[]): void {
		for (const r of rects) this.device.queue.writeTexture(
			{ texture: this.tintTexture, origin: [r.x, r.y, 0] }, r.data,
			{ bytesPerRow: r.width * 4, rowsPerImage: r.height }, [r.width, r.height, 3]);
	}

	static async create(canvas: HTMLCanvasElement, textureNames: string[], playerNames: PlayerNames): Promise<Renderer> {
		if (!("gpu" in navigator)) {
			throw new Error("このブラウザはWebGPUに対応していません。最新のChrome、Edge、Safari、Firefoxをお試しください。");
		}
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
		if (!adapter) throw new Error("WebGPUアダプターを取得できませんでした。");
		const device = await adapter.requestDevice();
		const info = adapter.info;
		const label = [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "unknown adapter";
		const skins = await Promise.all(entitySkins.map(async ({ url, width, height }) => {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`Failed to load mob skin: ${url.pathname} (${response.status})`);
			const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: "none" });
			if (image.width !== width || image.height !== height) {
				image.close();
				throw new Error(`Unexpected mob skin dimensions: ${url.pathname}`);
			}
			return image;
		}));
		try {
			return new Renderer(canvas, device, label, textureNames, playerNames, skins);
		} finally {
			for (const skin of skins) skin.close();
		}
	}

	/** Replaces (or removes, when empty) the mesh of one section. */
	setSection(cx: number, sy: number, cz: number, words: Uint32Array, counts: LayerCounts): void {
		const k = key(cx, sy, cz);
		const old = this.sections.get(k);
		const layers = splitMeshLayers(words, counts);
		const quads = words.length / WORDS_PER_QUAD;
		if (quads > MAX_QUADS) throw new Error("Section mesh exceeds model quad limit");
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
			old.translucentIndices?.destroy();
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
		const translucentIndices = counts[2] ? this.device.createBuffer({ size: counts[2] * 24, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }) : null;
		// Initial order is valid even before this section receives its budgeted sort.
		if (translucentIndices) this.device.queue.writeBuffer(translucentIndices, 0, this.quadIndexData.subarray(0, counts[2] * 6));
		this.sections.set(k, { slot, buffer, quads, counts, origin: [cx * 16, MIN_Y + sy * 16, cz * 16], centers: quadCenters(layers[2]), translucentIndices, sortedAt: "", cx, sy, cz });
	}

	private dropSection(k: string, mesh: SectionMesh): void {
		mesh.buffer.destroy();
		mesh.translucentIndices?.destroy();
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
	render(camera: Camera, viewDistance: number, target: RayHit | null, fovY = FOV_Y, dayTime = 6000, items: readonly RenderItem[] = [], now = 0, digs: readonly RenderDig[] = [], mobs: readonly RenderMob[] = [], particles: readonly ExplosionParticle[] = [], players: readonly RenderPlayer[] = []): FrameStats {
		this.resize();
		const sky = skyState(dayTime, viewDistance);
		this.device.queue.writeTexture({ texture: this.lightTexture }, lightmap(sky.skylight), { bytesPerRow: 64 }, [16, 16]);
		const cloudFogEnd = Math.max(256, viewDistance * 16 * 2);
		// Keep the cloud plane visible through its entire fade, including diagonal views.
		const far = Math.max((viewDistance + 2) * 16 * 2, cloudFogEnd * 2);
		const viewProj = viewProjection(camera.yaw, camera.pitch, fovY, this.canvas.width / this.canvas.height, NEAR, far);
		const planes = frustumPlanes(viewProj);
		const block = [Math.floor(camera.x), Math.floor(camera.y), Math.floor(camera.z)];
		const frac = [camera.x - block[0], camera.y - block[1], camera.z - block[2]];

		const f = this.globalsF32;
		const i = this.globalsI32;
		f.set(viewProj, 0);
		i.set([block[0], block[1], block[2], 0], 16);
		f.set([frac[0], frac[1], frac[2], 0], 20);
		f.set([...sky.fogColor, 1], 24);
		const fogEnd = viewDistance * 16;
		f.set([fogEnd * 0.75, fogEnd, 0, 0], 28);
		const tick = Math.floor(dayTime);
		// Power-of-two flipbooks also wrap when a world clock starts before tick zero.
		i[32] = this.firstWaterFrame + (Math.floor(tick / 2) & (FLUID_FRAMES.water - 1));
		i[33] = this.firstWaterFrame + FLUID_FRAMES.water + (tick & (FLUID_FRAMES.water_flow - 1));
		i[34] = this.firstLavaFrame + (Math.floor(tick / 16) & (FLUID_FRAMES.lava - 1));
		i[35] = this.firstLavaFrame + FLUID_FRAMES.lava + (Math.floor(tick / 10) & (FLUID_FRAMES.lava_flow - 1));
		f.set([...sky.skyColor, sky.skyBrightness], 36);
		f.set([...sky.sunsetColor, sky.sunsetStrength], 40);
		f.set([sky.angle, sky.starBrightness, sky.moonPhase, 0], 44);
		const look = forward(camera.yaw, camera.pitch);
		const side = right(camera.yaw);
		const up: Vec3 = [side[1] * look[2] - side[2] * look[1], side[2] * look[0] - side[0] * look[2], side[0] * look[1] - side[1] * look[0]];
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

		const crackData = digVertices(digs.slice(0, MAX_RENDER_ITEMS), [camera.x, camera.y, camera.z], this.crackTextureBase);
		if (crackData.length) this.device.queue.writeBuffer(this.crackBuffer, 0, crackData);
		const heldItems: RenderSprite[] = [];
		const eye: Vec3 = [camera.x, camera.y, camera.z];
		const visibleMobs = mobs.filter(mob => mobInFrustum(mob, eye, planes)).slice(0, MAX_RENDER_ITEMS);
		const visiblePlayers = players.filter(({ position: [x, y, z] }) => boxInFrustum(planes,
			x - eye[0] - 0.75, y - eye[1] - 0.1, z - eye[2] - 0.75, 1.5, 2.4, 1.5))
			.slice(0, MAX_RENDER_ITEMS - visibleMobs.length);
		this.playerNames.update(players, visiblePlayers, eye, viewProj);
		const mobData = mobVertices([...visibleMobs, ...visiblePlayers], eye, now, { output: heldItems, textures: this.heldItemTextures });
		const itemData = itemVertices(limitRenderItems(items), eye, now, heldItems);
		const flameData = flameVertices(visibleMobs, eye, now, this.firstFlameFrame);
		const explosionData = explosionVertices(particles, eye, side, up, now, this.firstExplosionFrame);
		if (itemData.length) this.device.queue.writeBuffer(this.itemBuffer, 0, itemData);
		if (flameData.length) this.device.queue.writeBuffer(this.itemBuffer, itemData.byteLength, flameData);
		if (explosionData.length) this.device.queue.writeBuffer(this.itemBuffer, itemData.byteLength + flameData.byteLength, explosionData);
		if (mobData.length) {
			if (!this.mobBuffer || this.mobBuffer.size < mobData.byteLength) {
				this.mobBuffer?.destroy();
				this.mobBuffer = this.device.createBuffer({
					size: mobData.byteLength,
					usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
				});
			}
			this.device.queue.writeBuffer(this.mobBuffer, 0, mobData);
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

		const visible = filterVisibleSections(this.sections, this.visibleSections).filter(mesh => boxInFrustum(planes,
			mesh.origin[0] - block[0] - frac[0], mesh.origin[1] - block[1] - frac[1], mesh.origin[2] - block[2] - frac[2], 16));
		const cameraPoint: Point = [camera.x, camera.y, camera.z];
		const transparent = sortSections(visible.filter(mesh => mesh.counts[2] > 0), cameraPoint);
		updateTranslucentSort(transparent, cameraPoint, (mesh, local) => {
			this.device.queue.writeBuffer(mesh.translucentIndices!, 0, sortedQuadIndices(mesh.centers, local));
		});
		const cloudsFirst = cloudsBeforeTranslucent(camera.y);
		// Clouds test opaque/cutout depth without writing it, on either side of the plane.
		const drawClouds = () => {
			pass.setPipeline(this.clouds);
			pass.setBindGroup(0, this.skyBind);
			pass.draw(6);
		};
		for (const [layer, pipeline] of [this.terrain, this.cutout, this.translucent].entries()) {
			if (layer === 2) {
				if (itemData.length) {
					pass.setPipeline(this.items);
					pass.setBindGroup(0, this.terrainBind);
					pass.setVertexBuffer(0, this.itemBuffer);
					pass.draw(itemData.length / 9);
				}
				if (this.mobBuffer && mobData.length) {
					pass.setPipeline(this.mobs);
					pass.setBindGroup(0, this.mobBind);
					pass.setVertexBuffer(0, this.mobBuffer);
					pass.draw(mobData.length / 9);
				}
				const effectVertices = (flameData.length + explosionData.length) / 9;
				if (effectVertices) {
					pass.setPipeline(this.flames);
					pass.setBindGroup(0, this.terrainBind);
					pass.setVertexBuffer(0, this.itemBuffer);
					pass.draw(effectVertices, 1, itemData.length / 9);
				}
				if (cloudsFirst) drawClouds();
			}
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, this.terrainBind);
			for (const mesh of layer === 2 ? transparent : visible) {
				const count = mesh.counts[layer];
				if (!count) continue;
				const offset = layer === 0 ? 0 : layer === 1 ? mesh.counts[0] : mesh.counts[0] + mesh.counts[1];
				pass.setVertexBuffer(0, mesh.buffer);
				pass.setIndexBuffer(layer === 2 ? mesh.translucentIndices! : this.quadIndices, "uint32");
				pass.drawIndexed(count * 6, 1, layer === 2 ? 0 : offset * 6, layer === 2 ? offset * 4 : 0, mesh.slot);
			}
		}
		const drawn = visible.length;
		const quads = visible.reduce((sum, mesh) => sum + mesh.quads, 0);

		if (!cloudsFirst) drawClouds();

		if (crackData.length) {
			pass.setPipeline(this.cracks);
			pass.setBindGroup(0, this.terrainBind);
			pass.setVertexBuffer(0, this.crackBuffer);
			pass.draw(crackData.length / 9);
		}

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

/** Twelve edges of the selected box, slightly enlarged and relative to the camera. */
export function outlineBox(target: RayHit, block: number[], frac: number[]): Float32Array<ArrayBuffer> {
	const e = 0.002;
	const position = [target.x, target.y, target.z];
	const lo = position.map((v, a) => v + target.min[a] - block[a] - frac[a] - e);
	const hi = position.map((v, a) => v + target.max[a] - block[a] - frac[a] + e);
	const corner = (n: number) => [n & 1 ? hi[0] : lo[0], n & 2 ? hi[1] : lo[1], n & 4 ? hi[2] : lo[2]];
	const edges = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
	const out = new Float32Array(24 * 3);
	edges.forEach((n, i) => out.set(corner(n), i * 3));
	return out;
}
