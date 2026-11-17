import { advanceDig, newDigState, type DigOverlay } from "./dig.ts";
// Client entry point: wires the WebAssembly mirror, the renderer, a transport
// and input together: fixed-step player prediction, interpolated rendering,
// block breaking and placing, and a debug overlay.
//
// URL parameters:
//   server=local|ws   integrated server in a Web Worker (default) or the Durable Object
//   world=<name>      world to open (default "main")
//   view=<chunks>     view distance, 2..12 (default 8)
//   gen=flat|hills|terrain  generator for a new local world (default terrain)
//   seed=<int64>      seed for a new local world
//   time=<tick>       starting day time for the local server
//   cull=0            disable section visibility culling
//   autopilot=1       no input needed: the camera circles above the spawn point

import { LOGGED_IN_ELSEWHERE, ACCESS_REVOKED } from "../shared/close-codes.ts";
import { TintMap, tintBudgetMs, type CellTint } from "./tint-map.ts";
import { Generator, ServerCore } from "../shared/server-core.ts";
import clientWasmUrl from "../wasm/client.wasm?url";
import serverWasmUrl from "../wasm/server.wasm?url";
import { advancePlayerFrame, type RayHit, ClientCore, PLAYER_TICK_SECONDS, S2C } from "./client-core.ts";
import { ACTIONS, type Action, defaultSettings, keyLabel, duplicateKeys, effectiveKeyConflicts, LOCKABLE_CODES, loadSettings, matchesKey, mouseDegrees, saveSettings, sprintKey, validKey } from "./input-settings.ts";
import { hotbarStates } from "./hotbar.ts";
import { placementState } from "./placement.ts";
import { LightPool } from "./light-pool.ts";
import { MeshPool, meshWorkerCount } from "./mesh-pool.ts";
import { interpolateEntity } from "./entities.ts";
import { forward } from "./math.ts";
import { type Camera, type FrameStats, Renderer } from "./renderer.ts";
import { parseStartTime, partialDayTicks } from "./sky.ts";
import { TEX_SIZE, textureIconPixels } from "./textures.ts";
import { LocalTransport, type ServerStats, type Transport, WebSocketTransport } from "./transport.ts";

const EYE_HEIGHT = 1.62;
/** Block interaction range in creative mode. */
const REACH = 5;
const DOUBLE_TAP_TICKS = 7;
const MESH_BUDGET_MS = 4;

const params = new URLSearchParams(location.search);
const serverKind = params.get("server") === "ws" ? "ws" : "local";
const worldName = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(params.get("world") ?? "") ? params.get("world")! : "main";
const viewDistance = Math.max(2, Math.min(12, Math.round(Number(params.get("view") ?? 8) || 8)));
const seedParam = /^-?\d{1,19}$/.test(params.get("seed") ?? "") ? params.get("seed") : null;
const requestedGenerator = params.get("gen") === "flat" ? Generator.Flat : params.get("gen") === "hills" ? Generator.DebugHills : Generator.Terrain;
const startTime = parseStartTime(params.get("time"));
const autopilot = params.get("autopilot") === "1";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const hud = $<HTMLPreElement>("hud");
const overlay = $<HTMLDivElement>("overlay");
const statusLine = $<HTMLParagraphElement>("status");
const hotbar = $<HTMLDivElement>("hotbar");

type MenuView = "start" | "menu" | "controls" | "settings";
let failed = false;
let menuView: MenuView = "start";
let prepareMenuView: (view: MenuView) => void = () => {};
function showMenuView(view: MenuView): void {
	if (failed) view = "start";
	menuView = view;
	prepareMenuView(view);
	for (const [name, id] of Object.entries({ start: "start-panel", menu: "game-menu", controls: "controls-panel", settings: "settings-panel" })) {
		$(id).hidden = name !== view;
	}
	if (view === "menu") $("menu-message").textContent = "";
	overlay.hidden = autopilot || document.pointerLockElement !== null;
	if (!overlay.hidden) overlay.querySelector<HTMLElement>(".menu-panel:not([hidden]) button")?.focus();
}

function fail(message: string): void {
	failed = true;
	statusLine.textContent = message;
	statusLine.className = "error";
	$("start-to-title").hidden = false;
	$("block-picker").hidden = true;
	if (document.pointerLockElement !== null) document.exitPointerLock();
	showMenuView("start");
	hud.textContent = message;
}

interface DebugHandle {
	ready: boolean;
	error: string | null;
	frames: number;
	stats(): Record<string, unknown>;
	tint(x: number, z: number): CellTint | null;
	sendRawPosition(x: number, y: number, z: number): void;
	setCamera(x: number, y: number, z: number, yaw: number, pitch: number): void;
	setBlock(x: number, y: number, z: number, block: number): boolean;
	getBlock(x: number, y: number, z: number): number;
	stateName(id: number): string;
	stateId(name: string): number;
	playerPosition(): readonly number[];
	raycast(origin: readonly number[], direction: readonly number[], max: number): RayHit | null;
	toggleFlight(): boolean;
	runScenario(seed: string, ticks: number): Promise<string>;
	flush(): void;
	exportWorld(): Promise<Uint8Array>;
	importWorld(name: string, bytes: Uint8Array): Promise<void>;
}

declare global {
	interface Window {
		__mc: DebugHandle;
	}
}

async function canEnterWorld(): Promise<boolean> {
	const accountURL = `/?next=${encodeURIComponent(location.pathname + location.search)}`;
	const stop = (message: string): false => {
		fail(message);
		const link = document.createElement("a");
		link.href = accountURL;
		link.textContent = "タイトル画面でログイン";
		link.style.color = "#aaccff";
		$("start-panel").append(link);
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
	const lightPool = new LightPool(core, () => new Worker(new URL("./light.worker.ts", import.meta.url), { type: "module" }));
	const textureNames = core.textureNames();
	const renderer = await Renderer.create(canvas, textureNames);
	const tintMap = new TintMap(core.biomeColors(), (cx, cz) => core.tintCells(core.seed, generator!, cx, cz));
	const registry = core.blockRegistry();
	const items = core.itemRegistry();
	const itemTextures = new Map(items.map(item => [item.id, Math.max(0, textureNames.indexOf(registry[item.block ?? 0]?.texture))]));
	let mainThreadMeshMs = 0;
	const meshPool = new MeshPool(meshWorkerCount(navigator.hardwareConcurrency),
		() => new Worker(new URL("./mesh.worker.ts", import.meta.url), { type: "module" }),
		(section, vertices, counts) => renderer.setSection(...section, vertices, counts),
		section => core.requeueDirty(...section),
		section => !core.isDirty(...section) && core.getBlock(section[0] * 16, -64, section[2] * 16) !== -1);
	function removeUnloaded(): void {
		for (const [cx, cz] of core.takeUnloaded()) {
			meshPool.invalidateChunk(cx, cz);
			renderer.removeChunk(cx, cz);
		}
	}

	const camera: Camera = { x: 0.5, y: 80, z: 0.5, yaw: 0, pitch: 20 };
	let position: [number, number, number] = [camera.x, camera.y - EYE_HEIGHT, camera.z];
	let previousPosition = [...position];
	let movementTime = 0;
	let movementTick = 0;
	let lastJumpTap = -Infinity;
	let pendingJump = false;
	let pendingFlightToggle = false;
	function resetPlayer(): void {
		position = [camera.x, camera.y - EYE_HEIGHT, camera.z];
		previousPosition = [...position];
		movementTime = 0;
		lastJumpTap = -Infinity;
		pendingJump = pendingFlightToggle = false;
		core.resetPlayer(...position);
	}
	let joined = false;
	let joinedGameTime: number | null = null;
	let autopilotStartedAt: number | null = null;
	let opened = false;
	let connection: "open" | "reconnecting" | "closed" = "closed";
	let reconnects = 0;
	let positionsCorrected = 0;
	let closed: string | null = null;
	let selected = 1;
	let lightMs = 0;
	let serverStats: ServerStats | null = null;
	let scenarioLine = "";
	let generator: number | null = null;
	let seedReady = false;
	const generatorName = () => generator === null ? "unknown" : generator === Generator.Flat ? "Flat" : generator === Generator.Terrain ? "Terrain" : "DebugHills";
	const timeSamples: Array<[number, number]> = [];
	let target: RayHit | null = null;
	let frame: FrameStats = { sections: 0, drawn: 0, quads: 0, skyBrightness: 1 };
	let timeReceivedAt = performance.now();
	let fps = 0;
	const entityReceivedAt = new Map<number, number>();

	// ---- transport ---------------------------------------------------------
	const handlers = {
		onGenerator: (id: number) => { generator = id; },
		onOpen: () => {
			seedReady = false;
			if (transport.kind !== "local") generator = null;
			tintMap.setWorld(null, null);
			if (opened) {
				meshPool.reset();
				core.resetWorld();
				entityReceivedAt.clear();
				remoteDigs.clear();
				dig = newDigState();
				removeUnloaded();
			}
			opened = true;
			transport.send(core.encodeHello(viewDistance));
		},
		onPacket: (data: Uint8Array) => {
			const id = core.packet(data);
			removeUnloaded();
			if (id === S2C.Inventory) syncInventory();
			if (id === S2C.DigProgress) {
				const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
				const player = v.getUint32(1), stage = v.getUint8(17);
				if (stage === 255) {
					const old = remoteDigs.get(player);
					if (old && old.x === v.getInt32(5) && old.y === v.getInt32(9) && old.z === v.getInt32(13)) remoteDigs.delete(player);
				}
				else remoteDigs.set(player, { x: v.getInt32(5), y: v.getInt32(9), z: v.getInt32(13), stage });
			}
			if (id === S2C.UnloadChunk) {
				const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
				for (const [player, d] of remoteDigs) if ((d.x >> 4) === v.getInt32(1) && (d.z >> 4) === v.getInt32(5)) remoteDigs.delete(player);
			}
			if (id === S2C.EntitySpawn || id === S2C.EntityMove) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				entityReceivedAt.set(view.getUint32(1), performance.now());
			}
			if (id === S2C.EntityRemove) entityReceivedAt.delete(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1));
			if (id === S2C.Welcome) {
				pendingSelectedSlot = null;
				seedReady = true;
				joinedGameTime = core.gameTime;
				timeReceivedAt = performance.now();
				const wasJoined = joined;
				if (!joined) {
					joined = true;
					const [sx, sy, sz] = core.spawn;
					camera.x = sx;
					camera.y = sy + EYE_HEIGHT + (autopilot ? 14 : 2);
					camera.z = sz;
					resetPlayer();
				} else {
					// Keep camera/prediction at the previous location. The DO restores
					// its accepted position; PlayerCorrect still wins if they differ.
					reconnects++;
					sendPosition();
				}
				connection = "open";
				timeSamples.length = 0;
				if (!failed) {
					$("start-to-title").hidden = true;
					statusLine.className = "";
					statusLine.textContent = "クリックして開始";
				}
				if (!locked()) showMenuView(wasJoined ? "menu" : "start");
				if (autopilot) overlay.hidden = true;
			} else if (id === S2C.PlayerCorrect) {
				positionsCorrected++;
				position = core.playerPosition;
				previousPosition = [...position];
				movementTime = 0;
				camera.x = position[0];
				camera.y = position[1] + EYE_HEIGHT;
				camera.z = position[2];
			} else if (id === S2C.TimeUpdate) {
				timeReceivedAt = performance.now();
				timeSamples.push([performance.now(), core.gameTime]);
				if (timeSamples.length > 6) timeSamples.shift();
			}
		},
		onStats: (stats: ServerStats) => {
			serverStats = stats;
		},
		onReconnecting: ({ attempt }: { attempt: number; delayMs: number; reason: string }) => {
			connection = "reconnecting";
			picker.hidden = true;
			$("start-to-title").hidden = false;
			showMenuView("start");
			timeSamples.length = 0;
			if (!failed) {
				statusLine.className = "";
				statusLine.textContent = `サーバーとの接続が切れました。再接続しています(${attempt}回目)…`;
			}
		},
		onClose: (reason: string, code?: number) => {
			connection = "closed";
			if (code === LOGGED_IN_ELSEWHERE) reason = "別の場所で同じアカウントが接続しました";
			if (code === ACCESS_REVOKED) reason = "このワールドへの参加が取り消されました";
			closed = reason;
			picker.hidden = true;
			if (locked()) document.exitPointerLock();
			fail(`サーバーとの接続が切れました: ${reason}`);
		},
	};
	const transport: Transport =
		serverKind === "ws"
			? new WebSocketTransport(worldName, handlers)
			: new LocalTransport(serverWasmUrl, worldName, seedParam, requestedGenerator, handlers, startTime, params.get("genworkers") !== "0", params.get("mode") === "survival" ? "survival" : "creative");

	const local = () => {
		if (!(transport instanceof LocalTransport)) throw new Error("シングルプレイでのみ使えます");
		return transport;
	};
	const exportWorld = () => local().exportWorld();
	const importWorld = (name: string, bytes: Uint8Array) => local().importWorld(name, bytes);
	const toTitle = $<HTMLAnchorElement>("to-title");
	let returningToTitle = false;
	toTitle.addEventListener("click", async event => {
		event.stopPropagation();
		if (!(transport instanceof LocalTransport)) return;
		event.preventDefault();
		if (returningToTitle) return;
		returningToTitle = true;
		const text = toTitle.textContent;
		toTitle.setAttribute("aria-disabled", "true");
		toTitle.textContent = "保存しています…";
		try {
			await transport.saveNow();
			location.assign("/");
		} catch (error) {
			returningToTitle = false;
			toTitle.removeAttribute("aria-disabled");
			toTitle.textContent = text;
			$("menu-message").textContent = error instanceof Error ? error.message : String(error);
		}
	});
	$("world-archive").hidden = serverKind !== "local";
	const exportButton = $<HTMLButtonElement>("world-export");
	const importButton = $<HTMLButtonElement>("world-import");
	const archiveStatus = $("archive-status");
	const fileInput = $<HTMLInputElement>("world-file");
	async function archiveAction(action: () => Promise<void>): Promise<void> {
		exportButton.disabled = importButton.disabled = true;
		archiveStatus.textContent = "処理中…";
		try { await action(); }
		catch (error) { archiveStatus.textContent = `処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`; }
		finally { exportButton.disabled = importButton.disabled = false; }
	}
	exportButton.addEventListener("click", () => void archiveAction(async () => {
		const bytes = await exportWorld();
		const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = `${worldName}-${new Date().toISOString().slice(0, 10)}.mcworld`;
		document.body.append(link);
		link.click(); link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		archiveStatus.textContent = "ワールドを書き出しました";
	}));
	importButton.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
	fileInput.addEventListener("change", () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		const defaultName = file.name.replace(/\.mcworld$/i, "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32) || "imported";
		const name = window.prompt("新しいワールド名（英小文字・数字で始まる32文字以内の英小文字・数字・_・-）", defaultName);
		if (name === null) return;
		void archiveAction(async () => {
			if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) throw new Error("ワールド名の形式が正しくありません");
			if (file.size > 1024 ** 3) throw new Error("ファイルは 1 GiB 以下にしてください");
			await importWorld(name, new Uint8Array(await file.arrayBuffer()));
			archiveStatus.textContent = "ワールドを読み込みました";
			const url = new URL(location.href);
			url.searchParams.set("world", name);
			location.assign(url);
		});
	});

	// ---- hotbar ------------------------------------------------------------
	const slots: HTMLCanvasElement[] = [];
	let hotbarBlocks: number[] = Array(9).fill(0);
	let selectedSlot = 0;
	let pendingSelectedSlot: number | null = null;
	function paintIcon(c: HTMLCanvasElement, state: number): void {
		c.width = c.height = TEX_SIZE;
		c.title = "";
		if (!state) return;
		const info = registry[state];
		const pixels = renderer.texturePixels.get(info.texture);
		if (pixels) c.getContext("2d")!.putImageData(new ImageData(textureIconPixels(info.texture, pixels), TEX_SIZE, TEX_SIZE), 0, 0);
		c.title = info.name;
	}
	for (const block of hotbarBlocks) {
		const c = document.createElement("canvas");
		paintIcon(c, block);
		hotbar.append(c);
		slots.push(c);
	}
	function selectSlot(slot: number, send = true): void {
		if (send) {
			pendingSelectedSlot = slot;
			transport.send(core.encodeSelectSlot(slot));
		}
		selectedSlot = slot;
		selected = hotbarBlocks[slot];
		slots.forEach((c, i) => c.classList.toggle("selected", i === slot));
	}
	function syncInventory(): void {
		const inventory = core.inventory;
		hotbarBlocks = hotbarStates(inventory, items);
		for (let i = 0; i < 9; i++) {
			const c = slots[i];
			paintIcon(c, hotbarBlocks[i]);
			const count = inventory[i]?.count ?? 0;
			c.dataset.count = String(count);
			if (count >= 2) {
				const icon = document.createElement("canvas");
				icon.width = icon.height = TEX_SIZE;
				icon.getContext("2d")!.drawImage(c, 0, 0);
				c.width = c.height = 64;
				const ctx = c.getContext("2d")!;
				ctx.imageSmoothingEnabled = false;
				ctx.drawImage(icon, 0, 0, 64, 64);
				ctx.font = "bold 23px monospace";
				ctx.textAlign = "right";
				ctx.lineWidth = 4;
				ctx.strokeStyle = "black";
				ctx.strokeText(String(count), 62, 61);
				ctx.fillStyle = "white";
				ctx.fillText(String(count), 62, 61);
			}
		}
		if (pendingSelectedSlot === core.selectedSlot) pendingSelectedSlot = null;
		selectSlot(pendingSelectedSlot ?? core.selectedSlot, false);
	}
	function replaceSlot(state: number): void {
		if (core.gameMode !== "creative") return;
		const item = items.find(item => item.block === registry[state].first);
		if (!item) return;
		transport.send(core.encodeCreativeSetSlot(selectedSlot, item.id, 1));
	}
	selectSlot(0, false);

	// ---- input -------------------------------------------------------------
	let settings = defaultSettings();
	// Accessing localStorage itself may throw (for example when storage is disabled).
	try { settings = loadSettings(localStorage); } catch { /* Keep defaults. */ }
	const keys = new Set<string>();
	const pressed = (assigned: string) => [...keys].some(code => matchesKey(code, assigned));
	let sprinting = false;
	let lastForwardTap = -Infinity;
	const heldButtons = new Map<number, number>();
	let leftHeld = false;
	let dig = newDigState();
	const remoteDigs = new Map<number, DigOverlay>();
	const stopDig = () => {
		leftHeld = false;
		const a = dig.active;
		const next = advanceDig(dig, false, null, a ? core.getBlock(a.x, a.y, a.z) : null, performance.now());
		dig = next.state;
		if (connection === "open" && next.commands.length) transport.send(core.encodeDigAbort());
	};
	const locked = () => document.pointerLockElement === canvas;
	const clearInput = () => {
		keys.clear();
		sprinting = false;
		lastForwardTap = -Infinity;
		lastJumpTap = -Infinity;
		pendingJump = pendingFlightToggle = false;
		heldButtons.clear();
		stopDig();
	};
	const warning = $<HTMLElement>("settings-warning");
	let capturing: Action | null = null;
	const labels: Record<Action, string> = { forward: "前進", backward: "後退", left: "左", right: "右", up: "ジャンプ / 上昇", down: "スニーク / 下降", sprint: "ダッシュ", fullscreen: "全画面", inventory: "ブロック選択", drop: "アイテムを捨てる" };
	const bindingButtons = new Map<Action, HTMLButtonElement>();
	function refreshSettings(): void {
		for (const [action, button] of bindingButtons) {
			button.textContent = capturing === action ? "キーを押してください…" : keyLabel(settings.keys[action]);
		}
		for (const name of ["sensitivity", "fov"] as const) {
			$<HTMLInputElement>(name).value = String(settings[name]);
			$(name + "-value").textContent = `${settings[name]}${name === "sensitivity" ? "%" : "°"}`;
		}
	}
	function persistSettings(): void {
		try {
			warning.textContent = saveSettings(localStorage, settings) ? "" : "設定を保存できません。再読み込みまで適用します。";
		} catch { warning.textContent = "設定を保存できません。再読み込みまで適用します。"; }
		refreshSettings();
		refreshControls();
		if (document.fullscreenElement === document.documentElement) void updateKeyboardLock();
	}
	for (const action of ACTIONS) {
		const label = document.createElement("label");
		label.textContent = labels[action];
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.action = action;
		button.className = "btn gray";
		button.addEventListener("click", () => { capturing = action; warning.textContent = ""; refreshSettings(); });
		label.append(button);
		$("key-bindings").append(label);
		bindingButtons.set(action, button);
	}
	function selectSettingsTab(tab: "keys" | "mouse"): void {
		capturing = null;
		refreshSettings();
		for (const name of ["keys", "mouse"] as const) {
			$(name + "-tab").setAttribute("aria-selected", String(name === tab));
			$(name + "-tab").tabIndex = name === tab ? 0 : -1;
			$(name + "-tab-panel").hidden = name !== tab;
		}
	}
	for (const name of ["keys", "mouse"] as const) {
		$(name + "-tab").addEventListener("click", () => selectSettingsTab(name));
		$(name + "-tab").addEventListener("keydown", event => {
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const next = event.key === "Home" ? "keys" : event.key === "End" ? "mouse" : name === "keys" ? "mouse" : "keys";
			selectSettingsTab(next);
			$(next + "-tab").focus();
		});
	}
	function refreshControls(): void {
		const kbd = (code: string) => {
			const element = document.createElement("kbd");
			element.textContent = keyLabel(code);
			return element;
		};
		const key = (action: Action) => kbd(action === "sprint" ? sprintKey(settings, keyboardLocked) : settings.keys[action]);
		const groups: Array<[string, Array<[string, Array<Node | string>]>]> = [
			["移動", [
				["前後左右", [key("forward"), " / ", key("left"), " / ", key("backward"), " / ", key("right")]],
				["ジャンプ / 上昇", [key("up")]], ["スニーク / 下降", [key("down")]],
				["ダッシュ", [key("sprint"), " または前進を2回"]], ["飛行の切替", [key("up"), " を2回"]],
			]],
			["ブロック", [
				["壊す", ["左クリック"]], ["置く", ["右クリック"]], ["見ているブロックを持つ", ["中クリック"]],
				["ブロック一覧", [key("inventory")]], ["ホットバーの切替", ["1〜9 / ホイール"]],
			]],
			["画面", [["メニュー", [kbd("Esc")]], ["全画面", [key("fullscreen")]]]],
			["開発者向け", [["決定論チェック", [kbd("F8")]]]],
		];
		$("controls-groups").replaceChildren(...groups.map(([title, rows]) => {
			const group = document.createElement("section");
			const heading = document.createElement("h3");
			heading.textContent = title;
			const list = document.createElement("dl");
			for (const [label, value] of rows) {
				const dt = document.createElement("dt");
				dt.textContent = label;
				const dd = document.createElement("dd");
				dd.append(...value);
				list.append(dt, dd);
			}
			group.append(heading, list);
			if (title === "画面") {
				const note = document.createElement("p");
				note.className = "controls-note";
				note.textContent = "全画面でキーボードを確保できたときは、ダッシュが左 Ctrl になります。";
				group.append(note);
			}
			return group;
		}));
	}
	prepareMenuView = view => {
		clearInput();
		capturing = null;
		if (view === "controls") refreshControls();
		if (view === "settings") selectSettingsTab("keys");
	};
	$("menu-world").textContent = worldName;
	const worldKind = document.createElement("span");
	worldKind.className = "world-kind";
	worldKind.textContent = serverKind === "local" ? "シングル" : "マルチ";
	$("menu-world").append(worldKind);
	$("menu-resume").addEventListener("click", () => { void requestPointerLock(); });
	$("menu-controls").addEventListener("click", () => showMenuView("controls"));
	$("settings-open").addEventListener("click", () => showMenuView("settings"));
	$("controls-to-settings").addEventListener("click", () => showMenuView("settings"));
	$("controls-close").addEventListener("click", () => showMenuView("menu"));
	$("settings-close").addEventListener("click", () => showMenuView("menu"));
	$("settings-reset").addEventListener("click", () => { settings = defaultSettings(); capturing = null; persistSettings(); });
	for (const name of ["sensitivity", "fov"] as const) {
		$<HTMLInputElement>(name).addEventListener("input", event => {
			settings[name] = Number((event.target as HTMLInputElement).value);
			persistSettings();
		});
	}
	refreshSettings();

	const picker = $("block-picker");
	const pickerButtons: HTMLButtonElement[] = [];
	registry.forEach((info, state) => {
		if (state === 0 || info.first !== state) return;
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.block = info.name;
		button.title = info.name;
		const icon = document.createElement("canvas");
		paintIcon(icon, state);
		const label = document.createElement("span");
		label.textContent = info.name;
		button.append(icon, label);
		button.addEventListener("click", () => replaceSlot(state));
		$("block-grid").append(button);
		pickerButtons.push(button);
	});
	function openPicker(): void {
		if (core.gameMode !== "creative") return;
		picker.querySelector("p")!.textContent = `クリックで現在のホットバー枠に設定。${settings.keys.inventory} / Esc で閉じます。`;
		clearInput();
		picker.hidden = false;
		overlay.hidden = true;
		if (locked()) document.exitPointerLock();
		pickerButtons.find(button => button.dataset.block === registry[selected].name)?.focus();
	}
	function closePicker(reason: "inventory" | "escape" | "button"): void {
		picker.hidden = true;
		clearInput();
		showMenuView(joined && !closed && connection === "open" ? "menu" : "start");
		if (reason !== "escape") void requestPointerLock();
	}
	$("block-picker-close").addEventListener("click", () => closePicker("button"));

	type KeyboardLock = { lock(codes: string[]): Promise<void>; unlock(): void };
	const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
	let keyboardLocked = false;
	let lockGeneration = 0;
	async function updateKeyboardLock(): Promise<void> {
		const generation = ++lockGeneration;
		keyboardLocked = false;
		clearInput();
		if (!keyboard?.lock) return;
		if (document.fullscreenElement !== document.documentElement) {
			keyboard.unlock();
			return;
		}
		try {
			await keyboard.lock(LOCKABLE_CODES);
			if (generation === lockGeneration && document.fullscreenElement === document.documentElement) keyboardLocked = true;
			else if (!document.fullscreenElement) keyboard.unlock();
		} catch { /* Unsupported or denied: keep the safe sprint key. */ }
	}
	document.addEventListener("fullscreenchange", () => { void updateKeyboardLock(); });
	async function toggleFullscreen(): Promise<void> {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await document.documentElement.requestFullscreen();
		} catch {
			if (failed) return;
			if (menuView === "start") statusLine.textContent = "全画面に切り替えられませんでした。";
			else $("menu-message").textContent = "全画面に切り替えられませんでした。";
		}
	}
	async function requestPointerLock(): Promise<void> {
		if (failed) return;
		try {
			await (canvas.requestPointerLock as (options: { unadjustedMovement: boolean }) => Promise<void> | void)({ unadjustedMovement: true });
		} catch {
			if (failed) return;
			try { await canvas.requestPointerLock(); }
			catch { pointerLockFailed(); }
		}
	}
	function pointerLockFailed(): void {
		if (failed) return;
		if (menuView === "start") statusLine.textContent = "マウスをロックできませんでした。クリックして再試行してください。";
		else $("menu-message").textContent = "少し待ってから、もう一度押してください。";
	}
	overlay.addEventListener("click", event => {
		if (joined && !closed && !failed && connection === "open" && picker.hidden && (menuView === "start" || event.target === overlay)) void requestPointerLock();
	});
	document.addEventListener("pointerlockchange", () => {
		if (!locked()) clearInput();
		if (failed) {
			if (locked()) document.exitPointerLock();
			showMenuView("start");
			return;
		}
		if (locked()) { $("menu-message").textContent = ""; overlay.hidden = true; return; }
		if (autopilot) { overlay.hidden = true; return; }
		if (!picker.hidden) { overlay.hidden = true; return; }
		showMenuView(joined && !closed && connection === "open" ? "menu" : "start");
	});
	document.addEventListener("mousemove", (e) => {
		if (!locked()) return;
		const degrees = mouseDegrees(settings.sensitivity);
		camera.yaw = (camera.yaw + e.movementX * degrees) % 360;
		camera.pitch = Math.max(-90, Math.min(90, camera.pitch + e.movementY * degrees));
	});
	window.addEventListener("keydown", (e) => {
		if (!overlay.hidden && menuView === "settings") {
			if (capturing) {
				e.preventDefault();
				if (e.repeat) return;
				if (e.code === "Escape") { capturing = null; refreshSettings(); return; }
				if (!validKey(e.code)) { warning.textContent = "このキーは割り当てられません（Esc / F8 / F11 は予約済み）。"; return; }
				const next = { ...settings.keys, [capturing]: e.code };
				if (duplicateKeys(next).length) { warning.textContent = "そのキーは別の操作に割り当て済みです。"; return; }
				if (effectiveKeyConflicts({ ...settings, keys: next }).length) { warning.textContent = "ダッシュの切替先が別の操作と重複するため、割り当てられません。"; return; }
				settings.keys = next;
				capturing = null;
				persistSettings();
			} else if (e.code === "Escape" && !locked()) {
				e.preventDefault();
				showMenuView("menu");
			}
			return;
		}
		if (!picker.hidden) {
			if (matchesKey(e.code, settings.keys.inventory) || e.code === "Escape") {
				e.preventDefault();
				if (!e.repeat) closePicker(e.code === "Escape" ? "escape" : "inventory");
			}
			return;
		}
		if (e.code === "Escape" && !locked() && !overlay.hidden) {
			e.preventDefault();
			if (menuView === "controls") showMenuView("menu");
			return;
		}
		if (matchesKey(e.code, settings.keys.inventory) && locked() && joined && !closed && !failed) {
			e.preventDefault();
			if (!e.repeat) openPicker();
			return;
		}
		if (matchesKey(e.code, settings.keys.fullscreen) && !e.repeat) {
			e.preventDefault();
			void toggleFullscreen();
			return;
		}
		if (matchesKey(e.code, settings.keys.drop) && locked() && joined && connection === "open") {
			e.preventDefault();
			if (!e.repeat) transport.send(core.encodeDropItem(forward(camera.yaw, camera.pitch)));
			return;
		}
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
		if (matchesKey(e.code, settings.keys.forward) && !e.repeat) {
			if (movementTick - lastForwardTap <= DOUBLE_TAP_TICKS) sprinting = true;
			lastForwardTap = movementTick;
		}
		if (matchesKey(e.code, settings.keys.up) && !e.repeat && !pressed(settings.keys.up)) {
			pendingJump = true;
			if (movementTick - lastJumpTap <= DOUBLE_TAP_TICKS) {
				pendingFlightToggle = !pendingFlightToggle;
				lastJumpTap = -Infinity;
			} else lastJumpTap = movementTick;
		}
		if (e.code.startsWith("Digit") && !Object.values(settings.keys).some(assigned => matchesKey(e.code, assigned))) selectSlot(Number(e.code.slice(5)) >= 1 && Number(e.code.slice(5)) <= 9 ? Number(e.code.slice(5)) - 1 : selectedSlot);
		keys.add(e.code);
	});
	window.addEventListener("keyup", (e) => {
		keys.delete(e.code);
		if (matchesKey(e.code, settings.keys.forward)) sprinting = false;
	});
	window.addEventListener("blur", clearInput);
	canvas.addEventListener("wheel", (e) => {
		if (!locked()) return;
		e.preventDefault();
		selectSlot((selectedSlot + Math.sign(e.deltaY) + slots.length) % slots.length);
	}, { passive: false });
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());

	const sendPosition = () => {
		if (autopilot) return;
		// Rendering may interpolate through a corner; report only resolved physics feet.
		transport.send(core.encodePlayerPos(camera.yaw, camera.pitch));
	};
	const setBlock = (x: number, y: number, z: number, block: number): boolean => {
		if (connection !== "open") return false;
		if (core.gameMode === "survival") {
			if (block === 0 || !hotbarBlocks[selectedSlot]) return false;
		}
		if (!core.predictBlock(x, y, z, block)) return false;
		// The server checks reach against the last position it knows.
		sendPosition();
		transport.send(core.encodeSetBlock(x, y, z, block));
		return true;
	};
	function interact(button: number): void {
		// Recast each time: prediction and camera motion can change the target between repeats.
		const hit = core.raycast([camera.x, camera.y, camera.z], forward(camera.yaw, camera.pitch), REACH);
		if (!hit) return;
		if (button === 0) {
			if (core.gameMode === "survival") return;
			setBlock(hit.x, hit.y, hit.z, 0);
		} else if (button === 2) {
			if (!selected) return;
			const edit = placementState(registry, selected, hit, camera.yaw, (x, y, z) => core.getBlock(x, y, z));
			if (edit) setBlock(edit.x, edit.y, edit.z, edit.state);
		} else if (button === 1) {
			const block = registry[core.getBlock(hit.x, hit.y, hit.z)];
			if (block && block.first > 0) {
				const slot = hotbarBlocks.indexOf(block.first);
				if (slot >= 0) selectSlot(slot);
				else if (core.gameMode === "creative") replaceSlot(block.first);
			}
		}
	}
	canvas.addEventListener("mousedown", (e) => {
		if (!locked()) return;
		e.preventDefault();
		if (e.button === 0 && core.gameMode === "survival") { leftHeld = true; return; }
		if (e.button === 0 || e.button === 2) heldButtons.set(e.button, performance.now() + (e.button === 0 ? 250 : 200));
		interact(e.button);
	});
	window.addEventListener("mouseup", e => { heldButtons.delete(e.button); if (e.button === 0) stopDig(); });
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
			if (joined && autopilotStartedAt === null && core.chunkCount >= (2 * core.viewDistance + 1) ** 2 && core.dirtyCount === 0) {
				autopilotStartedAt = timeMs;
			}
			const angle = autopilotStartedAt === null ? 0 : (timeMs - autopilotStartedAt) / 9000;
			camera.x = sx + Math.cos(angle) * 28;
			camera.z = sz + Math.sin(angle) * 28;
			camera.y = sy + 22;
			// Look back at the spawn point.
			camera.yaw = (Math.atan2(camera.x - sx, sz - camera.z) * 180) / Math.PI;
			camera.pitch = 28;
			return;
		}
		movementTime = advancePlayerFrame(movementTime + dt, () => {
			previousPosition = [...position];
			if (pendingFlightToggle) core.toggleFlight();
			pendingFlightToggle = false;
			const fwd = (pressed(settings.keys.forward) ? 1 : 0) - (pressed(settings.keys.backward) ? 1 : 0);
			const strafe = (pressed(settings.keys.right) ? 1 : 0) - (pressed(settings.keys.left) ? 1 : 0);
			const sprint = sprinting || pressed(sprintKey(settings, keyboardLocked && document.fullscreenElement === document.documentElement));
			const state = core.tickPlayer(fwd, strafe, camera.yaw, pendingJump || pressed(settings.keys.up), sprint, pressed(settings.keys.down));
			pendingJump = false;
			position = state.position;
			movementTick++;
		}, sendPosition);
		const alpha = movementTime / PLAYER_TICK_SECONDS;
		camera.x = previousPosition[0] + (position[0] - previousPosition[0]) * alpha;
		camera.y = previousPosition[1] + (position[1] - previousPosition[1]) * alpha + EYE_HEIGHT;
		camera.z = previousPosition[2] + (position[2] - previousPosition[2]) * alpha;
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
		const mspt = serverStats && serverStats.msptMean !== null
			? `${serverStats.msptMean.toFixed(2)} (max ${serverStats.msptMax?.toFixed(2) ?? "n/a"})`
			: "n/a";
		const yaw = ((camera.yaw % 360) + 360) % 360;
		const day = core.dayTime;
		// Day time 0 is 06:00, 24000 ticks per day.
		const minutes = Math.floor((((day % 24000) + 6000) % 24000) * 0.06);
		const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
		const lines = [
			`cf-minecraft  [${renderer.adapterInfo}]`,
			`${fps.toFixed(0)} fps`,
			`XYZ: ${camera.x.toFixed(2)} / ${(camera.y - EYE_HEIGHT).toFixed(2)} / ${camera.z.toFixed(2)}   Chunk: ${Math.floor(camera.x) >> 4} ${Math.floor(camera.z) >> 4}`,
			`Facing: ${FACING[Math.round(yaw / 90) % 4]}  (${yaw.toFixed(1)} / ${camera.pitch.toFixed(1)})`,
			`Sections: ${frame.drawn}/${core.chunkCount * 24} drawn  visible ${core.visibleSections}  ${frame.quads} quads  mesh queue ${core.dirtyCount} pending + ${meshPool.inFlight} in flight + ${meshPool.pendingResults} awaiting upload  chunks ${core.chunkCount}`,
			`Server: ${transport.kind} "${worldName}"${connection === "reconnecting" ? "  reconnecting" : ""}  TPS ${measuredTps().toFixed(2)}` +
				(serverStats
					? `  MSPT ${mspt}  loaded ${serverStats.loadedChunks}  save ${serverStats.persistence}  wasm ${(serverStats.memoryBytes / 1048576).toFixed(0)} MiB`
					: ""),
			`Dig: ${dig.active ? `${dig.active.x},${dig.active.y},${dig.active.z} stage ${dig.active.stage}` : "-"}`,
			`Biome: ${serverStats?.biome ?? "?"}  Game mode: ${core.gameMode}  Entities: ${core.entities.length}`,
			`Seed: ${core.seed}  Generator: ${generatorName()}  Day ${Math.floor(day / 24000)} ${clock}  (tick ${core.gameTime})`,
			target ? `Target: ${target.x} ${target.y} ${target.z}  ${registry[core.getBlock(target.x, target.y, target.z)]?.stateName ?? "?"}` : "Target: -",
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
		let fallbackMeshMs = 0;
		lightMs = 0;
		const frameDtMs = now - last;
		const dt = Math.min(0.1, frameDtMs / 1000);
		last = now;

		if (joined) {
			move(dt, now);

			removeUnloaded();
			const visible = core.updateVisibility(camera.x, camera.y, camera.z, params.get("cull") !== "0");
			if (visible !== undefined) renderer.visibleSections = visible;
			lightMs = lightPool.step(camera.x, camera.z);
			const pop = () => core.popDirty(camera.x, camera.y, camera.z);
			if (meshPool.useFallback) {
				const start = performance.now();
				do {
					const section = pop();
					if (!section) break;
					const words = core.mesh(...section);
					renderer.setSection(...section, words, core.meshCounts());
				} while (performance.now() - start < MESH_BUDGET_MS);
				fallbackMeshMs = performance.now() - start;
			} else {
				meshPool.applyResults();
				meshPool.pump(pop, section => core.padded(...section), section => core.paddedLight(...section));
			}

			target = core.raycast([camera.x, camera.y, camera.z], forward(camera.yaw, camera.pitch), REACH);
		}

		// Include worker replies/uploads between frames as well as this frame's dispatch.
		mainThreadMeshMs = fallbackMeshMs + meshPool.takeMainThreadMs();
		if (locked()) {
			for (const [button, next] of heldButtons) {
				if (now < next) continue;
				interact(button);
				heldButtons.set(button, now + (button === 0 ? 250 : 200));
			}
		}
		if (core.gameMode === "survival") {
			const blockState = target ? core.getBlock(target.x, target.y, target.z) : 0;
			const ticks = registry[blockState]?.digTicks;
			const digTarget = target && ticks != null ? { x: target.x, y: target.y, z: target.z, state: blockState, ticks } : null;
			const a = dig.active;
			const next = advanceDig(dig, leftHeld && locked() && joined && connection === "open", digTarget,
				a ? core.getBlock(a.x, a.y, a.z) : null, now);
			dig = next.state;
			if (connection === "open") for (const command of next.commands) {
				if (command.type === "abort") transport.send(core.encodeDigAbort());
				else { const t = command.target; sendPosition(); transport.send(core.encodeDigStart(t.x,t.y,t.z)); }
			}
		}
		tintMap.setWorld(seedReady ? core.seed : null, generator);
		tintMap.update(Math.floor(camera.x / 16), Math.floor(camera.z / 16), viewDistance + 1, tintBudgetMs(frameDtMs));
		renderer.writeTints(tintMap.takeUploads());
		const renderItems = core.entities.map(entity => ({
			position: interpolateEntity(entity.previous, entity.position, now - (entityReceivedAt.get(entity.id) ?? now)),
			texture: itemTextures.get(entity.item) ?? 0,
			light: core.entityLight(entity.position),
		}));
		frame = renderer.render(camera, viewDistance, target, settings.fov, core.dayTime + partialDayTicks(now, timeReceivedAt, joined && connection === "open"), renderItems, now, [...remoteDigs.values(), ...(dig.active ? [dig.active] : [])]);
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
		tint: (x, z) => tintMap.tint(x, z),
		stats: () => ({
			gameMode: core.gameMode,
			entities: core.entities,
			dig: dig.active,
			inventory: core.inventory,
			selectedSlot: core.selectedSlot,
			joined,
			joinedGameTime,
			autopilotStarted: autopilotStartedAt !== null,
			closed,
			connection,
			reconnects,
			positionsCorrected,
			fps,
			...frame,
			sections: core.chunkCount * 24,
			visibleSections: core.visibleSections,
			hiddenDirty: core.hiddenDirty,
			meshQueue: core.dirtyCount + meshPool.visiblePending(renderer.visibleSections),
			lightQueue: lightPool.queue,
			lightFallback: lightPool.useFallback,
			lightMs,
			meshPendingResults: meshPool.pendingResults,
			meshPending: core.dirtyCount,
			meshInFlight: meshPool.inFlight,
			meshWorkers: meshPool.workerCount,
			mainThreadMeshMs,
			chunks: core.chunkCount,
			gameTime: core.gameTime,
			tps: measuredTps(),
			server: serverStats,
			adapter: renderer.adapterInfo,
			camera: { ...camera },
			spawn: core.spawn,
			generator,
			generatorName: generatorName(),
			seed: core.seed.toString(),
		}),
		sendRawPosition: (x, y, z) => transport.send(core.encodePos(x, y, z, camera.yaw, camera.pitch)),
		setCamera: (x, y, z, yaw, pitch) => {
			transport.send(core.encodeTeleport(x, y - EYE_HEIGHT, z));
			Object.assign(camera, { x, y, z, yaw, pitch });
			resetPlayer();
		},
		setBlock,
		getBlock: (x, y, z) => core.getBlock(x, y, z),
		stateName: id => registry[id]?.stateName ?? "?",
		stateId: name => registry.findIndex(info => info.stateName === name || info.name === name),
		playerPosition: () => core.playerPosition,
		raycast: (origin, direction, max) => core.raycast(origin, direction, max),
		toggleFlight: () => core.toggleFlight(),
		runScenario,
		flush: () => transport.flush(),
		exportWorld,
		importWorld,
	};
	requestAnimationFrame(tick);
}

window.__mc = {
	ready: false,
	error: null,
	frames: 0,
	stats: () => ({}),
	tint: () => null,
	sendRawPosition: () => {},
	setCamera: () => {},
	setBlock: () => false,
	getBlock: () => -1,
	stateName: () => "?",
	stateId: () => -1,
	playerPosition: () => [],
	raycast: () => null,
	toggleFlight: () => false,
	runScenario,
	flush: () => {},
	exportWorld: async () => { throw new Error("初期化中です"); },
	importWorld: async () => { throw new Error("初期化中です"); },
};

main().catch((err) => {
	window.__mc.error = String(err);
	fail(err instanceof Error ? err.message : String(err));
});
