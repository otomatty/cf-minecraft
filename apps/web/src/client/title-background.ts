import clientWasmUrl from "../wasm/client.wasm?url";
import serverWasmUrl from "../wasm/server.wasm?url";
import { ClientCore, MIN_Y, S2C } from "./client-core.ts";
import type { GenReply, GenRequest } from "./gen.worker.ts";
import { LightPool } from "./light-pool.ts";
import { MeshPool, meshWorkerCount } from "./mesh-pool.ts";
import { PlayerNames } from "./player-names.ts";
import { FOV_Y, Renderer, type Camera } from "./renderer.ts";
import type { TexturePack } from "./texture-pack.ts";
import type { TextureLayout } from "./textures.ts";
import { TintMap } from "./tint-map.ts";
import { titleCameraHeight, titleChunks, titleLandscape, titleYaw } from "./title-landscape.ts";

const { seed, generator, x, z, radius, yaw, pitch, dayTime } = titleLandscape;
const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
const MAX_Y = MIN_Y + 384 - 1;

// The generation worker returns the serialized chunk without its S2C header.
function chunkPacket(cx: number, cz: number, bytes: Uint8Array): Uint8Array {
	const packet = new Uint8Array(9 + bytes.length);
	const view = new DataView(packet.buffer);
	view.setUint8(0, S2C.ChunkData);
	view.setInt32(1, cx);
	view.setInt32(5, cz);
	packet.set(bytes, 9);
	return packet;
}

function configureWorld(core: ClientCore, camera: Camera): void {
	// Supply the view distance used by the client's visibility traversal.
	const packet = new Uint8Array(43);
	const view = new DataView(packet.buffer);
	view.setUint8(0, S2C.Welcome);
	view.setBigInt64(1, seed);
	view.setBigInt64(9, BigInt(dayTime));
	view.setFloat64(17, camera.x);
	view.setFloat64(25, camera.y);
	view.setFloat64(33, camera.z);
	view.setUint8(41, radius);
	view.setUint8(42, 0); // Creative
	if (core.packet(packet) !== S2C.Welcome) throw new Error("Invalid title world metadata");
}

export async function createTitleBackground(canvas: HTMLCanvasElement, layout: TextureLayout, signal: AbortSignal) {
	const motion = matchMedia("(prefers-reduced-motion: reduce)");
	const camera: Camera = { x, y: 80, z, yaw, pitch };
	const chunks = titleChunks(cx, cz, radius);
	let renderer: Renderer;
	let core: ClientCore | undefined;
	let light: LightPool | undefined;
	let mesh: MeshPool | undefined;
	let tints: TintMap | undefined;
	let worker: Worker | undefined;
	let frame = 0;
	let elapsed = 0;
	let lastDraw: number | undefined;
	let stopped = false;
	let received = 0;
	let result: Extract<GenReply, { type: "result" }> | undefined;
	let terrainDrawn = false;
	let pack: TexturePack | undefined;
	let pendingPack: TexturePack | undefined;

	function stop(): void {
		if (stopped) return;
		stopped = true;
		cancelAnimationFrame(frame);
		worker?.terminate();
		light?.dispose();
		mesh?.dispose();
		renderer?.dispose();
		worker = undefined;
		light = undefined;
		mesh = undefined;
		tints = undefined;
		core = undefined;
		result = undefined;
		canvas.hidden = true;
		document.body.classList.remove("terrain-background");
		document.removeEventListener("visibilitychange", visibilityChanged);
		window.removeEventListener("resize", wake);
		motion.removeEventListener("change", wake);
	}

	function fail(error: unknown): void {
		if (stopped || signal.aborted) return;
		console.warn("タイトル背景を描画できません", error);
		stop();
	}

	signal.addEventListener("abort", stop, { once: true });
	try {
		renderer = await Renderer.create(canvas, layout, new PlayerNames(document.createElement("div")), undefined, { signal, onError: fail });
	} catch (error) {
		fail(error);
		return;
	}
	if (stopped) {
		renderer.dispose();
		return;
	}
	document.addEventListener("visibilitychange", visibilityChanged);
	window.addEventListener("resize", wake);
	motion.addEventListener("change", wake);
	wake();

	function wake(): void {
		if (!stopped && !document.hidden && !frame) frame = requestAnimationFrame(draw);
	}

	function visibilityChanged(): void {
		if (document.hidden) {
			cancelAnimationFrame(frame);
			frame = 0;
			lastDraw = undefined;
		} else wake();
	}

	function requestChunk(): void {
		const chunk = chunks[received];
		if (chunk) worker!.postMessage({ type: "generate", id: received, cx: chunk[0], cz: chunk[1] } satisfies GenRequest);
		else {
			worker?.terminate();
			worker = undefined;
		}
	}

	async function startTerrain(): Promise<void> {
		const client = await ClientCore.load(clientWasmUrl);
		if (stopped) return;
		core = client;
		light = new LightPool(client, () => new Worker(new URL("./light.worker.ts", import.meta.url), { type: "module" }));
		mesh = new MeshPool(Math.min(2, meshWorkerCount(navigator.hardwareConcurrency)),
			() => new Worker(new URL("./mesh.worker.ts", import.meta.url), { type: "module" }),
			(section, vertices, counts) => renderer.setSection(...section, vertices, counts),
			section => client.requeueDirty(...section), section => !client.isDirty(...section));
		tints = new TintMap(client.biomeColors(), (x, z) => client.tintCells(seed, generator, x, z));
		tints.setWorld(seed, generator);
		worker = new Worker(new URL("./gen.worker.ts", import.meta.url), { type: "module" });
		worker.onerror = event => {
			event.preventDefault();
			fail(new Error(event.message));
		};
		worker.onmessageerror = () => fail(new Error("Invalid title chunk worker reply"));
		worker.onmessage = ({ data }: MessageEvent<GenReply>) => {
			try {
				switch (data.type) {
					case "ready": requestChunk(); break;
					case "result": result = data; wake(); break;
					case "error": throw new Error(data.message);
				}
			} catch (error) { fail(error); }
		};
		worker.postMessage({ type: "init", wasmUrl: serverWasmUrl, seed: String(seed), generator } satisfies GenRequest);
	}

	function draw(now: number): void {
		frame = 0;
		if (document.hidden) return;
		if (!motion.matches && lastDraw !== undefined && now - lastDraw < 32) {
			wake();
			return;
		}
		try {
			if (pendingPack && pendingPack !== pack) {
				renderer.applyTexturePack(pendingPack);
				if (!pack) void startTerrain().catch(fail);
				pack = pendingPack;
			}
			if (result && core) {
				const [cx, cz] = chunks[received];
				if (result.id !== received || core.packet(chunkPacket(cx, cz, result.bytes)) !== S2C.ChunkData) {
					throw new Error("Invalid generated title chunk");
				}
				if (received === 0) {
					camera.y = titleCameraHeight(MIN_Y, MAX_Y, y => core!.getBlock(Math.floor(x), y, Math.floor(z)));
					configureWorld(core, camera);
				}
				result = undefined;
				received++;
				requestChunk();
			}
			if (core && mesh && light && tints) {
				tints.update(cx, cz, radius, 2);
				renderer.writeTints(tints.takeUploads());
				if (received) {
					const visible = core.updateVisibility(x, camera.y, z, true);
					if (visible !== undefined) renderer.visibleSections = visible;
					light.step(x, z);
					const client = core;
					const pop = () => client.popDirty(x, camera.y, z);
					if (mesh.useFallback) {
						const deadline = performance.now() + 2;
						for (let section = pop(); section; section = pop()) {
							const words = client.mesh(...section);
							renderer.setSection(...section, words, client.meshCounts());
							if (performance.now() >= deadline) break;
						}
					} else {
						mesh.applyResults();
						mesh.pump(pop, section => client.padded(...section), section => client.paddedLight(...section));
					}
				}
			}

			if (terrainDrawn && !motion.matches && lastDraw !== undefined) elapsed += now - lastDraw;
			lastDraw = now;
			camera.yaw = titleYaw(elapsed, motion.matches);
			canvas.hidden = false;
			const { drawn } = renderer.render(camera, radius, null, FOV_Y, dayTime);
			terrainDrawn ||= drawn > 0;
			document.body.classList.toggle("terrain-background", terrainDrawn);
			const pending = core && (received < chunks.length || core.dirtyCount || light?.queue ||
				mesh?.inFlight || mesh?.pendingResults || tints?.updating);
			if (pending || (terrainDrawn && !motion.matches)) wake();
			else lastDraw = undefined;
		} catch (error) { fail(error); }
	}

	return {
		setPack(next: TexturePack): void {
			pendingPack = next;
			wake();
		},
	};
}
