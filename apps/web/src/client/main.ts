// Client entry point: wires the WebAssembly mirror, the renderer, a transport
// and input together. M0 scope: a flying camera with no collision, block
// breaking and placing, and a debug overlay.
//
// URL parameters:
//   server=local|ws   integrated server in a Web Worker (default) or the Durable Object
//   world=<name>      world to open (default "main")
//   view=<chunks>     view distance, 2..12 (default 8)
//   seed=<int64>      seed for a new local world
//   autopilot=1       no input needed: the camera circles above the spawn point

import { LOGGED_IN_ELSEWHERE, ACCESS_REVOKED } from "../shared/close-codes.ts";
import { Generator, ServerCore } from "../shared/server-core.ts";
import clientWasmUrl from "../wasm/client.wasm?url";
import serverWasmUrl from "../wasm/server.wasm?url";
import { ClientCore, FACE_NORMALS, S2C } from "./client-core.ts";
import { forward, right } from "./math.ts";
import { type Camera, type FrameStats, Renderer } from "./renderer.ts";
import { TEX_SIZE } from "./textures.ts";
import { LocalTransport, type ServerStats, type Transport, WebSocketTransport } from "./transport.ts";

const EYE_HEIGHT = 1.62;
/** Block interaction range in creative mode. */
const REACH = 5;
/** Creative flying speeds in blocks per second; movement itself is a placeholder until M1. */
const FLY_SPEED = 10.89;
const SPRINT_FLY_SPEED = 21.78;
const VERTICAL_SPEED = 7.5;
/** Degrees per pixel at the default mouse sensitivity. */
const MOUSE_DEGREES = 0.15;
const DOUBLE_TAP_MS = 350;
const POSITION_INTERVAL_MS = 50;
const MESH_BUDGET_MS = 4;

const params = new URLSearchParams(location.search);
const serverKind = params.get("server") === "ws" ? "ws" : "local";
const worldName = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(params.get("world") ?? "") ? params.get("world")! : "main";
const viewDistance = Math.max(2, Math.min(12, Number(params.get("view") ?? 8) || 8));
const seedParam = /^-?\d{1,19}$/.test(params.get("seed") ?? "") ? params.get("seed") : null;
const autopilot = params.get("autopilot") === "1";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const hud = $<HTMLPreElement>("hud");
const overlay = $<HTMLDivElement>("overlay");
const statusLine = $<HTMLParagraphElement>("status");
const hotbar = $<HTMLDivElement>("hotbar");

function fail(message: string): void {
	statusLine.textContent = message;
	statusLine.className = "error";
	overlay.hidden = false;
	hud.textContent = message;
}

interface DebugHandle {
	ready: boolean;
	error: string | null;
	frames: number;
	stats(): Record<string, unknown>;
	setCamera(x: number, y: number, z: number, yaw: number, pitch: number): void;
	setBlock(x: number, y: number, z: number, block: number): boolean;
	getBlock(x: number, y: number, z: number): number;
	runScenario(seed: string, ticks: number): Promise<string>;
	flush(): void;
}

declare global {
	interface Window {
		__mc: DebugHandle;
	}
}

async function canEnterWorld(): Promise<boolean> {
	const accountURL = `/account.html?next=${encodeURIComponent(location.pathname + location.search)}`;
	const stop = (message: string): false => {
		fail(message);
		const link = document.createElement("a");
		link.href = accountURL;
		link.textContent = "アカウントページへ";
		link.style.color = "#aaccff";
		document.getElementById("panel")!.append(link);
		return false;
	};
	const response = await fetch("/api/me");
	if (response.status === 503) throw new Error("本番の認証設定が未完了です");
	if (!response.ok) throw new Error(`ログイン確認に失敗しました (${response.status})`);
	const me = await response.json();
	if (me.open) return true;
	if (!me.user) return stop("マルチプレイにはログインが必要です");
	const world = await fetch(`/api/worlds/${encodeURIComponent(worldName)}`);
	if (world.status === 404) return stop(`ワールド ${worldName} はありません`);
	if (world.status === 403) return stop("このワールドに招待されていません");
	if (world.status === 401) return stop("マルチプレイにはログインが必要です");
	if (world.status === 503) throw new Error("本番の認証設定が未完了です");
	if (!world.ok) throw new Error(`ワールドの確認に失敗しました (${world.status})`);
	return true;
}

async function runScenario(seed: string, ticks: number): Promise<string> {
	const { instance } = await WebAssembly.instantiateStreaming(fetch(serverWasmUrl), {});
	return new ServerCore(instance).runScenario(BigInt(seed), ticks);
}

async function main(): Promise<void> {
	if (serverKind === "ws" && !await canEnterWorld()) return;
	const core = await ClientCore.load(clientWasmUrl);
	const renderer = await Renderer.create(canvas, core.textureNames());
	const blockNames = core.blockNames();

	const camera: Camera = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 20 };
	const velocity = [0, 0, 0];
	let joined = false;
	let opened = false;
	let connection: "open" | "reconnecting" | "closed" = "closed";
	let reconnects = 0;
	let closed: string | null = null;
	let selected = 1;
	let serverStats: ServerStats | null = null;
	let scenarioLine = "";
	const timeSamples: Array<[number, number]> = [];
	let target: { x: number; y: number; z: number; face: number } | null = null;
	let frame: FrameStats = { sections: 0, drawn: 0, quads: 0 };
	let fps = 0;

	// ---- transport ---------------------------------------------------------
	const handlers = {
		onOpen: () => {
			if (opened) core.resetWorld();
			opened = true;
			transport.send(core.encodeHello(viewDistance));
		},
		onPacket: (data: Uint8Array) => {
			const id = core.packet(data);
			if (id === S2C.Welcome) {
				if (!joined) {
					joined = true;
					const [sx, sy, sz] = core.spawn;
					camera.x = sx;
					camera.y = sy + EYE_HEIGHT + (autopilot ? 14 : 2);
					camera.z = sz;
				} else {
					reconnects++;
					sendPosition();
				}
				connection = "open";
				timeSamples.length = 0;
				statusLine.className = "";
				statusLine.textContent = "クリックして開始";
				if (autopilot) overlay.hidden = true;
			} else if (id === S2C.TimeUpdate) {
				timeSamples.push([performance.now(), core.gameTime]);
				if (timeSamples.length > 6) timeSamples.shift();
			}
		},
		onStats: (stats: ServerStats) => {
			serverStats = stats;
		},
		onReconnecting: ({ attempt }: { attempt: number; delayMs: number; reason: string }) => {
			connection = "reconnecting";
			timeSamples.length = 0;
			statusLine.className = "";
			statusLine.textContent = `サーバーとの接続が切れました。再接続しています(${attempt}回目)…`;
		},
		onClose: (reason: string, code?: number) => {
			connection = "closed";
			if (code === LOGGED_IN_ELSEWHERE) reason = "別の場所で同じアカウントが接続しました";
			if (code === ACCESS_REVOKED) reason = "このワールドへの参加が取り消されました";
			closed = reason;
			fail(`サーバーとの接続が切れました: ${reason}`);
		},
	};
	const transport: Transport =
		serverKind === "ws"
			? new WebSocketTransport(worldName, handlers)
			: new LocalTransport(serverWasmUrl, worldName, seedParam, Generator.DebugHills, handlers);

	// ---- hotbar ------------------------------------------------------------
	const slots: HTMLCanvasElement[] = [];
	const textureNames = new Set(core.textureNames());
	for (let block = 1; block <= 9 && block < blockNames.length; block++) {
		const c = document.createElement("canvas");
		c.width = c.height = TEX_SIZE;
		const name = blockNames[block];
		const tex = textureNames.has(name) ? name : `${name}_side`;
		const pixels = renderer.texturePixels.get(tex);
		if (pixels) {
			c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), TEX_SIZE, TEX_SIZE), 0, 0);
		}
		c.title = name;
		hotbar.append(c);
		slots.push(c);
	}
	const select = (block: number) => {
		selected = Math.max(1, Math.min(slots.length, block));
		slots.forEach((c, i) => c.classList.toggle("selected", i + 1 === selected));
	};
	select(1);

	// ---- input -------------------------------------------------------------
	const keys = new Set<string>();
	let sprinting = false;
	let lastForwardTap = 0;
	const locked = () => document.pointerLockElement === canvas;

	overlay.addEventListener("click", () => {
		if (joined && !closed) canvas.requestPointerLock();
	});
	document.addEventListener("pointerlockchange", () => {
		if (autopilot || closed) return;
		overlay.hidden = locked();
		if (!locked()) {
			keys.clear();
			if (connection !== "reconnecting") statusLine.textContent = "一時停止中：クリックして再開";
		}
	});
	document.addEventListener("mousemove", (e) => {
		if (!locked()) return;
		camera.yaw = (camera.yaw + e.movementX * MOUSE_DEGREES) % 360;
		camera.pitch = Math.max(-90, Math.min(90, camera.pitch + e.movementY * MOUSE_DEGREES));
	});
	window.addEventListener("keydown", (e) => {
		if (e.code === "F8") {
			e.preventDefault();
			scenarioLine = "Scenario: 実行中…";
			runScenario("2026", 600).then(
				(hash) => (scenarioLine = `Scenario(2026, 600): ${hash}`),
				(err) => (scenarioLine = `Scenario: ${err}`),
			);
			return;
		}
		if (!locked()) return;
		e.preventDefault();
		if (e.code === "KeyW" && !e.repeat) {
			const now = performance.now();
			if (now - lastForwardTap < DOUBLE_TAP_MS) sprinting = true;
			lastForwardTap = now;
		}
		if (e.code.startsWith("Digit")) select(Number(e.code.slice(5)));
		keys.add(e.code);
	});
	window.addEventListener("keyup", (e) => {
		keys.delete(e.code);
		if (e.code === "KeyW") sprinting = false;
	});
	window.addEventListener("blur", () => keys.clear());
	canvas.addEventListener("wheel", (e) => {
		if (!locked()) return;
		e.preventDefault();
		select(((selected - 1 + Math.sign(e.deltaY) + slots.length) % slots.length) + 1);
	}, { passive: false });
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());

	let lastPositionSent = 0;
	const sendPosition = () => {
		lastPositionSent = performance.now();
		transport.send(core.encodePos(camera.x, camera.y - EYE_HEIGHT, camera.z, camera.yaw, camera.pitch));
	};
	const setBlock = (x: number, y: number, z: number, block: number): boolean => {
		if (connection !== "open") return false;
		if (!core.predictBlock(x, y, z, block)) return false;
		// The server checks reach against the last position it knows.
		sendPosition();
		transport.send(core.encodeSetBlock(x, y, z, block));
		return true;
	};
	canvas.addEventListener("mousedown", (e) => {
		if (!locked() || !target) return;
		if (e.button === 0) {
			setBlock(target.x, target.y, target.z, 0);
		} else if (e.button === 2) {
			const n = FACE_NORMALS[target.face];
			const [x, y, z] = [target.x + n[0], target.y + n[1], target.z + n[2]];
			if (core.getBlock(x, y, z) === 0) setBlock(x, y, z, selected);
		} else if (e.button === 1) {
			e.preventDefault();
			const block = core.getBlock(target.x, target.y, target.z);
			if (block > 0) select(block);
		}
	});
	window.addEventListener("pagehide", () => transport.flush());
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) transport.resume?.();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") transport.flush();
	});

	// ---- simulation of the camera ---------------------------------------
	const spawnForAutopilot = () => core.spawn;
	function move(dt: number, timeMs: number): void {
		if (autopilot) {
			const [sx, sy, sz] = spawnForAutopilot();
			const angle = timeMs / 9000;
			camera.x = sx + Math.cos(angle) * 28;
			camera.z = sz + Math.sin(angle) * 28;
			camera.y = sy + 22;
			// Look back at the spawn point.
			camera.yaw = (Math.atan2(camera.x - sx, sz - camera.z) * 180) / Math.PI;
			camera.pitch = 28;
			return;
		}
		const fwd = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
		const strafe = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
		const up = (keys.has("Space") ? 1 : 0) - (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1 : 0);
		const f = forward(camera.yaw, 0);
		const r = right(camera.yaw);
		let wx = f[0] * fwd + r[0] * strafe;
		let wz = f[2] * fwd + r[2] * strafe;
		const len = Math.hypot(wx, wz);
		const speed = sprinting || keys.has("ControlLeft") ? SPRINT_FLY_SPEED : FLY_SPEED;
		if (len > 0) {
			wx = (wx / len) * speed;
			wz = (wz / len) * speed;
		}
		const blend = 1 - Math.exp(-dt * 12);
		velocity[0] += (wx - velocity[0]) * blend;
		velocity[1] += (up * VERTICAL_SPEED - velocity[1]) * blend;
		velocity[2] += (wz - velocity[2]) * blend;
		camera.x += velocity[0] * dt;
		camera.y = Math.max(-80, Math.min(400, camera.y + velocity[1] * dt));
		camera.z += velocity[2] * dt;
	}

	// ---- HUD ---------------------------------------------------------------
	const FACING = ["south (+Z)", "west (-X)", "north (-Z)", "east (+X)"];
	function measuredTps(): number {
		if (serverStats) return serverStats.tps;
		if (timeSamples.length < 2) return 0;
		const [t0, g0] = timeSamples[0];
		const [t1, g1] = timeSamples[timeSamples.length - 1];
		return ((g1 - g0) / (t1 - t0)) * 1000;
	}
	function updateHud(): void {
		const yaw = ((camera.yaw % 360) + 360) % 360;
		const day = core.dayTime;
		// Day time 0 is 06:00, 24000 ticks per day.
		const minutes = Math.floor((((day % 24000) + 6000) % 24000) * 0.06);
		const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
		const lines = [
			`maincraft M0  [${renderer.adapterInfo}]`,
			`${fps.toFixed(0)} fps`,
			`XYZ: ${camera.x.toFixed(2)} / ${(camera.y - EYE_HEIGHT).toFixed(2)} / ${camera.z.toFixed(2)}   Chunk: ${Math.floor(camera.x) >> 4} ${Math.floor(camera.z) >> 4}`,
			`Facing: ${FACING[Math.round(yaw / 90) % 4]}  (${yaw.toFixed(1)} / ${camera.pitch.toFixed(1)})`,
			`Sections: ${frame.drawn}/${frame.sections} drawn  ${frame.quads} quads  mesh queue ${core.dirtyCount}  chunks ${core.chunkCount}`,
			`Server: ${transport.kind} "${worldName}"${connection === "reconnecting" ? "  reconnecting" : ""}  TPS ${measuredTps().toFixed(2)}` +
				(serverStats
					? `  MSPT ${serverStats.msptMean.toFixed(2)} (max ${serverStats.msptMax.toFixed(2)})  loaded ${serverStats.loadedChunks}  save ${serverStats.persistence}  wasm ${(serverStats.memoryBytes / 1048576).toFixed(0)} MiB`
					: ""),
			`Seed: ${core.seed}  Day ${Math.floor(day / 24000)} ${clock}  (tick ${core.gameTime})`,
			target ? `Target: ${target.x} ${target.y} ${target.z}  ${blockNames[core.getBlock(target.x, target.y, target.z)] ?? "?"}` : "Target: -",
		];
		if (scenarioLine) lines.push(scenarioLine);
		hud.textContent = lines.join("\n");
	}

	// ---- frame loop --------------------------------------------------------
	let last = performance.now();
	let hudAt = 0;
	let frames = 0;
	let fpsAt = last;
	function tick(now: number): void {
		if (renderer.lost) {
			fail(`GPUデバイスが失われました: ${renderer.lost}`);
			return;
		}
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;

		if (joined) {
			move(dt, now);
			if (now - lastPositionSent >= POSITION_INTERVAL_MS) sendPosition();

			for (const [cx, cz] of core.takeUnloaded()) renderer.removeChunk(cx, cz);
			const start = performance.now();
			do {
				const section = core.popDirty(camera.x, camera.y, camera.z);
				if (!section) break;
				renderer.setSection(section[0], section[1], section[2], core.mesh(section[0], section[1], section[2]));
			} while (performance.now() - start < MESH_BUDGET_MS);

			target = core.raycast([camera.x, camera.y, camera.z], forward(camera.yaw, camera.pitch), REACH);
		}

		frame = renderer.render(camera, viewDistance, target ? [target.x, target.y, target.z] : null);
		window.__mc.frames++;

		frames++;
		if (now - fpsAt >= 500) {
			fps = (frames * 1000) / (now - fpsAt);
			frames = 0;
			fpsAt = now;
		}
		if (now - hudAt >= 250) {
			hudAt = now;
			updateHud();
		}
		requestAnimationFrame(tick);
	}

	window.__mc = {
		ready: true,
		error: null,
		frames: 0,
		stats: () => ({
			joined,
			closed,
			connection,
			reconnects,
			fps,
			...frame,
			meshQueue: core.dirtyCount,
			chunks: core.chunkCount,
			gameTime: core.gameTime,
			tps: measuredTps(),
			server: serverStats,
			adapter: renderer.adapterInfo,
			camera: { ...camera },
			spawn: core.spawn,
			seed: core.seed.toString(),
		}),
		setCamera: (x, y, z, yaw, pitch) => Object.assign(camera, { x, y, z, yaw, pitch }),
		setBlock,
		getBlock: (x, y, z) => core.getBlock(x, y, z),
		runScenario,
		flush: () => transport.flush(),
	};
	requestAnimationFrame(tick);
}

window.__mc = {
	ready: false,
	error: null,
	frames: 0,
	stats: () => ({}),
	setCamera: () => {},
	setBlock: () => false,
	getBlock: () => -1,
	runScenario,
	flush: () => {},
};

main().catch((err) => {
	window.__mc.error = String(err);
	fail(err instanceof Error ? err.message : String(err));
});
