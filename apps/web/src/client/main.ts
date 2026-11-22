import { bindInventorySlot, containerScreenVisible, updateClosePending, inventoryDisplay, INVENTORY_ROWS, TABLE_ROWS, FURNACE_ROWS, type InventoryScreenKind } from "./inventory-screen.ts";
import { GameAudio } from "./audio/engine.ts";
import { VOLUME_CONTROLS } from "./audio/events.ts";
import { WorldAudio } from "./audio/world-audio.ts";
import { advanceDig, digSelection, updateDigSelection, newDigState, observeDigBlockUpdate, type DigOverlay } from "./dig.ts";
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
import { ACTIONS, type Action, defaultSettings, keyLabel, duplicateKeys, effectiveKeyConflicts, implicitEnterOpensChat, implicitSlashOpensChat, keyOpensChat, LOCKABLE_CODES, loadSettings, matchesKey, mouseDegrees, saveSettings, sprintKey, validKey } from "./input-settings.ts";
import { appendChatInput, appendChatLine, CHAT_VISIBLE_MS, formatChatLine, limitChatInput, recallChatInput, visibleChatLines, type ChatInputRecall, type TimedChatLine } from "./chat.ts";
import { hotbarStates, pickBlockItem } from "./hotbar.ts";
import { blockInteraction, bucketTarget, canTill, placementState, usesFluidSourceRay } from "./placement.ts";
import { LightPool } from "./light-pool.ts";
import { MeshPool, meshWorkerCount } from "./mesh-pool.ts";
import { interpolateEntity, MAX_EXPLOSION_PARTICLES, mobBeforeBlock, spawnExplosionParticles, type ExplosionParticle, type RenderMob, type RenderPlayer } from "./entities.ts";
import { PlayerNames } from "./player-names.ts";
import { forward, type Vec3 } from "./math.ts";
import { type Camera, type FrameStats, Renderer } from "./renderer.ts";
import { parseStartTime, partialDayTicks } from "./sky.ts";
import { TEX_SIZE, textureIconPixels } from "./textures.ts";
import { blockIconPixels, ICON_SIZE } from "./block-icon.ts";
import { LocalTransport, type ServerStats, type Transport, WebSocketTransport } from "./transport.ts";
import { pageCacheActions, type PageCacheAction } from "./page-cache.ts";
import { bubbleCount, deathCauses, foodStates, heartStates, MAX_AIR, MAX_FOOD } from "./vitals.ts";

const EYE_HEIGHT = 1.62;
/** Block interaction and mob attack range. */
const REACH = 5;
const LEFT_REPEAT_MS = 250;
const MOB_HURT_MS = 500;
const BOW_MAX_DRAW = 20;
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
const deathScreen = $<HTMLDialogElement>("death-screen");

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
	deathScreen.close();
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
	setDayTime(tick: number): boolean;
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
	const textureNames = [...core.textureNames(), "bow"];
	const arrowTexture = textureNames.indexOf("arrow");
	const renderer = await Renderer.create(canvas, textureNames, new PlayerNames($("player-names")));
	const tintMap = new TintMap(core.biomeColors(), (cx, cz) => core.tintCells(core.seed, generator!, cx, cz));
	const registry = core.blockRegistry();
	const items = core.itemRegistry();
	const itemTextures = new Map(items.map(item => [item.id, Math.max(0, textureNames.indexOf(item.texture ?? registry[item.block ?? 0]?.texture))]));
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
	const audio = new GameAudio(camera);
	const worldAudio = new WorldAudio(core, registry, audio);
	let position: [number, number, number] = [camera.x, camera.y - EYE_HEIGHT, camera.z];
	let previousPosition = [...position];
	let movementTime = 0;
	let movementTick = 0;
	let lastJumpTap = -Infinity;
	let pendingJump = false;
	let pendingFlightToggle = false;
	function resetPlayer(feet: [number, number, number] = [camera.x, camera.y - EYE_HEIGHT, camera.z]): void {
		position = feet;
		previousPosition = [...position];
		movementTime = 0;
		lastJumpTap = -Infinity;
		pendingJump = pendingFlightToggle = false;
		core.resetPlayer(...position);
		worldAudio.resetMovement();
	}
	let joined = false;
	let joinedGameTime: number | null = null;
	let autopilotStartedAt: number | null = null;
	let opened = false;
	let connection: "open" | "reconnecting" | "closed" = "closed";
	let reconnects = 0;
	let closePending = false;
	let positionsCorrected = 0;
	let packetSequence = 0;
	let knockbacksReceived = 0;
	let lastKnockback: { seq: number; velocity: Vec3; position: readonly number[]; receivedAt: number; positionsCorrected: number } | null = null;
	let explosionsReceived = 0;
	let lastExplosion: { seq: number; center: Vec3; receivedAt: number } | null = null;
	let explosionParticles: ExplosionParticle[] = [];
	let renderedExplosionParticles = 0;
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
	const playerReceivedAt = new Map<number, number>();
	const mobHurtAt = new Map<number, number>();
	let renderMobs: Array<RenderMob & { id: number }> = [];

	const chatPanel = $("chat");
	const chatLog = $("chat-log");
	const chatInput = $<HTMLInputElement>("chat-input");
	let chatOpen = false;
	let chatOpeningKey = "";
	let chatHistory: TimedChatLine[] = [];
	let chatInputHistory: string[] = [];
	let chatInputRecall: ChatInputRecall | null = null;
	const chatLineClasses = ["chat-player", "chat-join", "chat-leave", "chat-system", "chat-emote", "chat-whisper-from", "chat-whisper-to"];
	let chatExpiry: ReturnType<typeof setTimeout> | undefined;
	function renderChat(): void {
		clearTimeout(chatExpiry);
		const now = performance.now();
		const visible = visibleChatLines(chatHistory, chatOpen, now);
		const atBottom = chatLog.scrollHeight - chatLog.clientHeight - chatLog.scrollTop <= 1;
		const scrollTop = chatLog.scrollTop;
		chatPanel.hidden = !chatOpen && visible.length === 0;
		chatLog.replaceChildren(...visible.map(({ line, receivedAt }) => {
			const row = document.createElement("div");
			row.className = chatLineClasses[line.kind];
			row.textContent = formatChatLine(line);
			if (!chatOpen) row.style.animationDelay = `-${now - receivedAt}ms`;
			return row;
		}));
		chatLog.scrollTop = chatOpen && !atBottom ? scrollTop : chatLog.scrollHeight;
		if (!chatOpen && visible.length > 0) {
			chatExpiry = setTimeout(renderChat, visible[0].receivedAt + CHAT_VISIBLE_MS - now);
		}
	}

	function closeChat(resume: boolean): void {
		if (!chatOpen) return;
		chatOpen = false;
		chatOpeningKey = "";
		chatInputRecall = null;
		chatInput.hidden = true;
		chatInput.value = "";
		chatPanel.classList.remove("open");
		renderChat();
		if (resume) {
			showMenuView("menu");
			void requestPointerLock();
		}
	}

	// ---- transport ---------------------------------------------------------
	const handlers = {
		onGenerator: (id: number) => { generator = id; },
		onOpen: () => {
			closePending = false;
			seedReady = false;
			previousHealth = null;
			worldAudio.reset();
			if (transport.kind !== "local") generator = null;
			tintMap.setWorld(null, null);
			if (opened) {
				meshPool.reset();
				core.resetWorld();
				entityReceivedAt.clear();
				playerReceivedAt.clear();
				mobHurtAt.clear();
				renderMobs = [];
				remoteDigs.clear();
				dig = newDigState();
				removeUnloaded();
			}
			opened = true;
			transport.send(core.encodeHello(viewDistance));
		},
		onPacket: (data: Uint8Array) => {
			const seq = ++packetSequence;
			const previousMode = data[0] === S2C.Welcome ? core.gameMode : undefined;
			const id = worldAudio.packet(data, position, mobHurtAt);
			if (id === S2C.Chat) {
				const line = core.takeChat();
				if (line) {
					chatHistory = appendChatLine(chatHistory, line, performance.now());
					renderChat();
				}
				return;
			}
			if (id === S2C.Explosion) {
				const now = performance.now();
				for (let center = core.takeExplosion(); center; center = core.takeExplosion()) {
					explosionsReceived++;
					lastExplosion = { seq, center, receivedAt: now };
					explosionParticles.push(...spawnExplosionParticles(center, now));
					explosionParticles.splice(0, Math.max(0, explosionParticles.length - MAX_EXPLOSION_PARTICLES));
				}
				return;
			}
			if (id === S2C.PlayerSpawn || id === S2C.PlayerMove || id === S2C.PlayerRemove) {
				const player = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
				if (id === S2C.PlayerRemove) playerReceivedAt.delete(player);
				else playerReceivedAt.set(player, performance.now());
				return;
			}
			removeUnloaded();
			if (id === S2C.Inventory) {
				syncInventory();
				closePending = updateClosePending(closePending, { type: "inventory", screen: core.screen });
				const kind = !core.dead && ([1, 2] as const).find(kind => containerScreenVisible({ screen: core.screen, closePending }, kind));
				if (kind) {
					const view = kind === 1 ? tableView : furnaceView;
					if (view.screen.hidden) openInventoryScreen(kind);
				} else if (!tableScreen.hidden || !furnaceScreen.hidden) closeInventoryScreen(false);
			}
			if (id === S2C.BlockUpdate) {
				const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
				const x = v.getInt32(1), y = v.getInt32(5), z = v.getInt32(9);
				dig = observeDigBlockUpdate(dig, x, y, z, core.getBlock(x, y, z), performance.now());
			}
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
			if (id === S2C.EntitySpawn || id === S2C.EntityMove || id === S2C.MobSpawn || id === S2C.MobMove ||
				id === S2C.ArrowSpawn || id === S2C.ArrowMove) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				entityReceivedAt.set(view.getUint32(1), performance.now());
			}
			if (id === S2C.MobHurt) {
				// Each MobHurt packet advances the mirror's hurt counter for this mob.
				mobHurtAt.set(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1), performance.now());
			}
			if (id === S2C.EntityRemove) {
				const entity = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1);
				entityReceivedAt.delete(entity);
				mobHurtAt.delete(entity);
			}
			if (id === S2C.Welcome) {
				pendingSelectedSlot = null;
				vitals.hidden = core.gameMode !== "survival";
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
					if (core.gameMode !== previousMode) resetPlayer(position);
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
			} else if (id === S2C.PlayerStatus) {
				syncVitals();
			} else if (id === S2C.PlayerKnockback) {
				const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
				knockbacksReceived++;
				lastKnockback = {
					seq,
					velocity: [view.getFloat64(1), view.getFloat64(9), view.getFloat64(17)],
					position: core.playerPosition, receivedAt: performance.now(), positionsCorrected,
				};
			} else if (id === S2C.PlayerCorrect) {
				positionsCorrected++;
				worldAudio.resetMovement();
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
			closeChat(false);
			endUsingItem();
			picker.hidden = true;
			hideInventoryScreens();
			deathScreen.close();
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
			closeChat(false);
			endUsingItem();
			if (code === LOGGED_IN_ELSEWHERE) reason = "別の場所で同じアカウントが接続しました";
			if (code === ACCESS_REVOKED) reason = "このワールドへの参加が取り消されました";
			closed = reason;
			picker.hidden = true;
			hideInventoryScreens();
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
	const icons = new Map<number, ImageData>();
	let pendingSelectedSlot: number | null = null;
	const eatProgress = $<HTMLProgressElement>("eat-progress");
	const arrowItemId = items.find(item => item.name === "arrow")?.id;
	let usingItem: { kind: "food" | "bow"; item: number; count: number; startedAt: number } | null = null;
	function endUsingItem(release = false): void {
		if (!usingItem) return;
		const bow = usingItem.kind === "bow";
		usingItem = null;
		eatProgress.hidden = true;
		if (connection !== "open") return;
		if (bow && !release) {
			transport.send(core.encodeCancelUsingItem());
		} else {
			if (bow) sendPosition();
			transport.send(core.encodeStopUsingItem());
		}
	}
	function bowDraw(now: number): number {
		return usingItem?.kind === "bow"
			? Math.max(0, Math.min(BOW_MAX_DRAW, Math.floor((now - usingItem.startedAt) / (PLAYER_TICK_SECONDS * 1000))))
			: 0;
	}
	let dig = newDigState();
	let heldInventory = "";
	function paintIcon(c: HTMLCanvasElement, state: number): void {
		c.width = c.height = ICON_SIZE;
		c.title = "";
		if (!state) return;
		const info = registry[state];
		let icon = icons.get(state);
		if (!icon) {
			icon = new ImageData(blockIconPixels(info, renderer.texturePixels), ICON_SIZE, ICON_SIZE);
			icons.set(state, icon);
		}
		c.getContext("2d")!.putImageData(icon, 0, 0);
		c.title = info.name;
	}
	for (const block of hotbarBlocks) {
		const c = document.createElement("canvas");
		paintIcon(c, block);
		hotbar.append(c);
		slots.push(c);
	}
	function selectSlot(slot: number, send = true): void {
		if (slot !== selectedSlot) endUsingItem();
		const next = updateDigSelection(dig, heldInventory, slot, core.inventory[slot]);
		dig = next.state;
		heldInventory = next.selection;
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
		paintInventoryScreen();
		hotbarBlocks = hotbarStates(inventory, items);
		for (let i = 0; i < 9; i++) {
			const c = slots[i];
			paintItemIcon(c, inventory[i]?.item);
			const count = inventory[i]?.count ?? 0;
			c.dataset.count = String(count);
			if (count >= 2) {
				const icon = document.createElement("canvas");
				icon.width = c.width;
				icon.height = c.height;
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
		if (usingItem) {
			const stack = inventory[selectedSlot];
			if (stack?.item !== usingItem.item) {
				endUsingItem();
			} else if (usingItem.kind === "food") {
				if (stack.count < usingItem.count) {
					usingItem.startedAt = performance.now();
					eatProgress.value = 0;
				}
				usingItem.count = stack.count;
			}
		}
	}
	function paintItemIcon(c: HTMLCanvasElement, id?: number): void {
		const item = items.find(item => item.id === id);
		paintIcon(c, item?.block ?? 0);
		if (item?.texture) {
			c.width = c.height = TEX_SIZE;
			const pixels = renderer.texturePixels.get(item.texture);
			if (pixels) c.getContext("2d")!.putImageData(new ImageData(textureIconPixels(item.texture, pixels), TEX_SIZE, TEX_SIZE), 0, 0);
		}
		if (item) c.title = item.name;
	}
	selectSlot(0, false);

	// ---- input -------------------------------------------------------------
	let settings = defaultSettings();
	// Accessing localStorage itself may throw (for example when storage is disabled).
	try { settings = loadSettings(localStorage); } catch { /* Keep defaults. */ }
	audio.updateVolumes(settings.audio);
	audio.setVisible(!document.hidden);
	document.addEventListener("click", event => {
		if (!event.isTrusted) return;
		const button = event.target instanceof Element && event.target.closest("button, a.btn");
		audio.activate(Boolean(button));
	}, { capture: true });
	document.addEventListener("keydown", event => {
		if (event.isTrusted && !event.repeat) audio.activate(false);
	}, { capture: true });
	const keys = new Set<string>();
	const pressed = (assigned: string) => [...keys].some(code => matchesKey(code, assigned));
	let sprinting = false;
	let lastForwardTap = -Infinity;
	const heldButtons = new Map<number, number>();
	let miningStartsAt = 0;
	const remoteDigs = new Map<number, DigOverlay>();
	const stopDig = () => {
		const a = dig.active;
		const next = advanceDig(dig, false, null, a ? core.getBlock(a.x, a.y, a.z) : null, performance.now());
		dig = next.state;
		if (!core.dead && connection === "open" && next.commands.length) transport.send(core.encodeDigAbort());
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
		endUsingItem();
	};
	const warning = $<HTMLElement>("settings-warning");
	let capturing: Action | null = null;
	const labels: Record<Action, string> = { forward: "前進", backward: "後退", left: "左", right: "右", up: "ジャンプ / 上昇", down: "スニーク / 下降", sprint: "ダッシュ", fullscreen: "全画面", inventory: "ブロック選択", drop: "アイテムを捨てる", chat: "チャット" };
	const bindingButtons = new Map<Action, HTMLButtonElement>();
	function refreshSettings(): void {
		for (const [action, button] of bindingButtons) {
			button.textContent = capturing === action ? "キーを押してください…" : keyLabel(settings.keys[action]);
		}
		for (const name of ["sensitivity", "fov"] as const) {
			$<HTMLInputElement>(name).value = String(settings[name]);
			$(name + "-value").textContent = `${settings[name]}${name === "sensitivity" ? "%" : "°"}`;
		}
		for (const channel of VOLUME_CONTROLS) {
			$<HTMLInputElement>(`volume-${channel}`).value = String(settings.audio[channel]);
			$(`volume-${channel}-value`).textContent = `${settings.audio[channel]}%`;
		}
	}
	function persistSettings(): void {
		audio.updateVolumes(settings.audio);
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
	const settingsTabs = ["keys", "mouse", "audio"] as const;
	function selectSettingsTab(tab: typeof settingsTabs[number]): void {
		capturing = null;
		refreshSettings();
		for (const name of settingsTabs) {
			$(name + "-tab").setAttribute("aria-selected", String(name === tab));
			$(name + "-tab").tabIndex = name === tab ? 0 : -1;
			$(name + "-tab-panel").hidden = name !== tab;
		}
	}
	for (const name of settingsTabs) {
		$(name + "-tab").addEventListener("click", () => selectSettingsTab(name));
		$(name + "-tab").addEventListener("keydown", event => {
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const direction = event.key === "ArrowLeft" ? -1 : 1;
			const index = (settingsTabs.indexOf(name) + direction + settingsTabs.length) % settingsTabs.length;
			const next = event.key === "Home" ? settingsTabs[0] : event.key === "End" ? settingsTabs.at(-1)! : settingsTabs[index];
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
		const chatKeys: Array<Node | string> = [key("chat")];
		if (implicitEnterOpensChat(settings.keys)) chatKeys.push(" / ", kbd("Enter"));
		if (implicitSlashOpensChat(settings.keys) && settings.keys.chat !== "Slash") chatKeys.push(" / ", kbd("Slash"));
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
			["画面", [["メニュー", [kbd("Esc")]], ["全画面", [key("fullscreen")]], ["チャット", chatKeys]]],
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
	for (const channel of VOLUME_CONTROLS) {
		$<HTMLInputElement>(`volume-${channel}`).addEventListener("input", event => {
			settings.audio[channel] = Number((event.target as HTMLInputElement).value);
			persistSettings();
		});
	}
	refreshSettings();

	function createInventoryScreen(kind: InventoryScreenKind) {
		const screen = document.createElement("section");
		screen.id = kind === 2 ? "furnace-screen" : kind === 1 ? "crafting-table-screen" : "inventory-screen";
		screen.className = "inventory-screen";
		screen.setAttribute("role", "dialog");
		screen.setAttribute("aria-modal", "true");
		screen.setAttribute("aria-label", kind === 2 ? "かまど" : kind === 1 ? "作業台" : "インベントリとクラフト");
		screen.hidden = true;
		const heading = document.createElement("h2");
		heading.textContent = kind === 2 ? "かまど" : kind === 1 ? "作業台" : "インベントリ / クラフト";
		screen.append(heading);
		const buttons = new Map<number, { canvas: HTMLCanvasElement; count: HTMLSpanElement }>();
		const rows = kind === 2 ? FURNACE_ROWS : kind === 1 ? TABLE_ROWS : INVENTORY_ROWS;
		const craftingRow = document.createElement("div");
		craftingRow.className = "inventory-crafting";
		for (const [index, row] of rows.entries()) {
			const group = document.createElement("div");
			const label = ["所持品", "ホットバー", kind === 2 ? "かまど（入力・燃料）" : "クラフト", "結果"][index];
			group.setAttribute("aria-label", label);
			group.className = `inventory-slots${index === 2 ? ` inventory-crafting-grid${kind === 2 ? " inventory-furnace-grid" : kind === 1 ? " inventory-table-grid" : ""}` : index === 3 ? " inventory-result" : ""}`;
			if (index !== 3) {
				const title = document.createElement("h3");
				title.textContent = label;
				screen.append(title);
			}
			for (const slot of row) {
				const button = document.createElement("button");
				button.type = "button";
				button.dataset.slot = String(slot);
				button.setAttribute("aria-label", kind === 2 && slot >= 51 ? `${["入力", "燃料", "出力"][slot - 51]} 枠 ${slot}` : `枠 ${slot}`);
				button.style.cssText = "position:relative;width:48px;height:48px;background:#525960;border:1px solid #aab2ba;color:white";
				const canvas = document.createElement("canvas");
				canvas.style.cssText = "width:32px;height:32px;image-rendering:pixelated";
				const count = document.createElement("span");
				count.style.cssText = "position:absolute;right:2px;bottom:0;text-shadow:1px 1px black";
				button.append(canvas,count);
				bindInventorySlot(button, slot, (slot, button, shift) => {
					transport.send(core.encodeClickSlot(slot, button, shift));
				});
				buttons.set(slot,{canvas,count});
				group.append(button);
			}
			if (index === 2) {
				craftingRow.append(group);
				screen.append(craftingRow);
			} else if (index === 3) {
				const arrow = document.createElement("span");
				arrow.textContent = "→";
				arrow.setAttribute("aria-hidden", "true");
				craftingRow.append(arrow, group);
			} else {
				screen.append(group);
			}
		}
		const gauges: HTMLProgressElement[] = [];
		if (kind === 2) {
			const meters = document.createElement("div");
			meters.className = "furnace-gauges";
			for (const [index, name] of ["燃焼", "精錬"].entries()) {
				const label = document.createElement("label");
				const progress = document.createElement("progress");
				progress.id = `furnace-${index === 0 ? "burn" : "smelt"}`;
				progress.setAttribute("role", "progressbar");
				progress.setAttribute("aria-label", name);
				progress.setAttribute("aria-valuemin", "0");
				label.htmlFor = progress.id;
				label.append(name, progress);
				meters.append(label);
				gauges.push(progress);
			}
			screen.append(meters);
		}
		const close = document.createElement("button");
		close.textContent = "閉じる (E / Esc)";
		close.addEventListener("click", () => closeInventoryScreen());
		screen.append(close);
		document.body.append(screen);
		return { screen, buttons, kind, gauges };
	}
	const inventoryView = createInventoryScreen(0);
	const tableView = createInventoryScreen(1);
	const inventoryScreen = inventoryView.screen;
	const tableScreen = tableView.screen;
	const furnaceView = createInventoryScreen(2);
	const furnaceScreen = furnaceView.screen;
	const cursorIcon = document.createElement("div");
	cursorIcon.style.cssText = "position:fixed;pointer-events:none;z-index:30;color:white;text-shadow:1px 1px black";
	const cursorCanvas = document.createElement("canvas");
	cursorCanvas.style.cssText = "width:32px;height:32px;image-rendering:pixelated";
	const cursorCount = document.createElement("span");
	cursorIcon.append(cursorCanvas,cursorCount);
	cursorIcon.hidden = true;
	document.body.append(cursorIcon);
	document.addEventListener("mousemove", event => {
		cursorIcon.style.left = `${event.clientX+12}px`;
		cursorIcon.style.top = `${event.clientY+12}px`;
	});
	function paintInventoryScreen(): void {
		const active = !furnaceScreen.hidden ? furnaceView : !tableScreen.hidden ? tableView : inventoryView;
		const display = inventoryDisplay(core.inventorySlots, active.kind);
		for (const group of display.groups) for (const {slot,stack} of group) {
			const view = active.buttons.get(slot)!;
			paintItemIcon(view.canvas, stack?.item);
			view.count.textContent = stack && stack.count >= 2 ? String(stack.count) : "";
			view.canvas.dataset.count = String(stack?.count ?? 0);
		}
		const [remaining, total, smelt] = core.furnaceTimes;
		for (const [index, gauge] of furnaceView.gauges.entries()) {
			const value = index === 0 ? remaining : smelt;
			const max = index === 0 ? total : 160;
			gauge.max = Math.max(1, max);
			gauge.value = value;
			gauge.setAttribute("aria-valuenow", String(value));
			gauge.setAttribute("aria-valuemax", String(max));
			gauge.textContent = `${value} / ${max}`;
		}
		paintItemIcon(cursorCanvas, display.cursor?.item);
		cursorCount.textContent = display.cursor && display.cursor.count >= 2 ? String(display.cursor.count) : "";
		cursorIcon.hidden = (inventoryScreen.hidden && tableScreen.hidden && furnaceScreen.hidden) || !display.cursor;
	}
	function openInventoryScreen(kind: InventoryScreenKind = 0): void {
		closeChat(false);
		clearInput();
		inventoryScreen.hidden = kind !== 0;
		tableScreen.hidden = kind !== 1;
		furnaceScreen.hidden = kind !== 2;
		picker.hidden = true;
		overlay.hidden = true;
		paintInventoryScreen();
		if (locked()) document.exitPointerLock();
	}
	function hideInventoryScreens(): void {
		inventoryScreen.hidden = true;
		tableScreen.hidden = true;
		furnaceScreen.hidden = true;
		cursorIcon.hidden = true;
	}
	function closeInventoryScreen(send = true): void {
		hideInventoryScreens();
		if (send) {
			closePending = updateClosePending(closePending, { type: "close" });
			transport.send(core.encodeCloseInventory());
		}
		clearInput();
		showMenuView(joined && !closed && connection === "open" ? "menu" : "start");
		void requestPointerLock();
	}
	const picker = $("block-picker");
	const pickerButtons: HTMLButtonElement[] = [];
	items.forEach(info => {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.block = info.name;
		button.title = info.name;
		const icon = document.createElement("canvas");
		paintItemIcon(icon, info.id);
		const label = document.createElement("span");
		label.textContent = info.name;
		button.append(icon, label);
		button.addEventListener("click", () => { if (core.gameMode === "creative") transport.send(core.encodeCreativeSetSlot(selectedSlot, info.id, 1)); });
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
		pickerButtons.find(button => button.dataset.block === slots[selectedSlot].title)?.focus();
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
		if (failed || core.dead || chatOpen) return;
		try {
			await (canvas.requestPointerLock as (options: { unadjustedMovement: boolean }) => Promise<void> | void)({ unadjustedMovement: true });
		} catch {
			if (failed || core.dead) return;
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
		if (joined && !closed && !failed && connection === "open" && picker.hidden && inventoryScreen.hidden && tableScreen.hidden && furnaceScreen.hidden && (menuView === "start" || event.target === overlay)) void requestPointerLock();
	});
	document.addEventListener("pointerlockchange", () => {
		if (!locked()) clearInput();
		if (failed) {
			if (locked()) document.exitPointerLock();
			showMenuView("start");
			return;
		}
		if (deathScreen.open) {
			if (locked()) document.exitPointerLock();
			return;
		}
		if (chatOpen) {
			overlay.hidden = true;
			if (!locked()) chatInput.focus();
			return;
		}
		if (locked()) { $("menu-message").textContent = ""; overlay.hidden = true; return; }
		if (autopilot) { overlay.hidden = true; return; }
		if (!picker.hidden || !inventoryScreen.hidden || !tableScreen.hidden || !furnaceScreen.hidden) { overlay.hidden = true; return; }
		showMenuView(joined && !closed && connection === "open" ? "menu" : "start");
	});
	document.addEventListener("mousemove", (e) => {
		if (!locked() || core.dead || chatOpen) return;
		const degrees = mouseDegrees(settings.sensitivity);
		camera.yaw = (camera.yaw + e.movementX * degrees) % 360;
		camera.pitch = Math.max(-90, Math.min(90, camera.pitch + e.movementY * degrees));
	});
	const limitInput = () => {
		const limited = limitChatInput(chatInput.value);
		if (chatInput.value !== limited) chatInput.value = limited;
	};
	chatInput.addEventListener("input", event => {
		if (!(event as InputEvent).isComposing) limitInput();
	});
	chatInput.addEventListener("compositionend", limitInput);

	window.addEventListener("keydown", (e) => {
		if (chatOpen) {
			if (e.isComposing) return;
			if (e.repeat && e.code === chatOpeningKey) {
				e.preventDefault();
				return;
			}
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();
				const next = recallChatInput(chatInputHistory, chatInputRecall, chatInput.value, e.key === "ArrowUp" ? -1 : 1);
				if (next) {
					chatInputRecall = next.recall;
					chatInput.value = next.value;
				}
				return;
			}
			if (e.key === "Enter" || e.key === "Escape") {
				e.preventDefault();
				if (e.repeat) return;
				const text = limitChatInput(chatInput.value).trim();
				if (e.key === "Enter" && text && connection === "open") {
					transport.send(core.encodeChat(text));
					chatInputHistory = appendChatInput(chatInputHistory, text);
				}
				closeChat(true);
			}
			return;
		}
		if (core.dead && connection === "open" && !failed) {
			if (e.code === "Escape") e.preventDefault();
			return;
		}
		if (!locked() && !overlay.hidden && menuView === "settings") {
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
			} else if (e.code === "Escape") {
				e.preventDefault();
				showMenuView("menu");
			}
			return;
		}
		if (!inventoryScreen.hidden || !tableScreen.hidden || !furnaceScreen.hidden) {
			if (matchesKey(e.code, settings.keys.inventory) || e.code === "Escape") {
				e.preventDefault();
				if (!e.repeat) closeInventoryScreen();
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
		if (canInteract() && keyOpensChat(settings.keys, e.code, e.key)) {
			e.preventDefault();
			if (e.repeat) return;
			chatOpen = true;
			chatOpeningKey = e.code;
			clearInput();
			chatInput.hidden = false;
			chatInput.value = e.key === "/" ? "/" : "";
			chatPanel.classList.add("open");
			renderChat();
			chatLog.scrollTop = chatLog.scrollHeight;
			document.exitPointerLock();
			chatInput.focus();
			chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
			return;
		}
		if (matchesKey(e.code, settings.keys.inventory) && locked() && joined && !closed && !failed) {
			e.preventDefault();
			if (!e.repeat) { if (core.gameMode === "survival") openInventoryScreen(); else openPicker(); }
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
		if (!locked() || core.dead || chatOpen) return;
		e.preventDefault();
		selectSlot((selectedSlot + Math.sign(e.deltaY) + slots.length) % slots.length);
	}, { passive: false });
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());

	const sendPosition = () => {
		if (autopilot || core.dead) return;
		// Rendering may interpolate through a corner; report only resolved physics feet.
		transport.send(core.encodePlayerPos(camera.yaw, camera.pitch));
	};
	const setBlock = (x: number, y: number, z: number, block: number): boolean => {
		if (connection !== "open" || core.dead) return false;
		if (core.gameMode === "survival") {
			if (block === 0 || !hotbarBlocks[selectedSlot]) return false;
		}
		if (!worldAudio.predictBlock(x, y, z, block)) return false;
		// The server checks reach against the last position it knows.
		sendPosition();
		transport.send(core.encodeSetBlock(x, y, z, block));
		return true;
	};
	function aimedBlock(includeSources = false): RayHit | null {
		return core.raycast([camera.x, camera.y, camera.z], forward(camera.yaw, camera.pitch), REACH, includeSources);
	}
	// Pointer lock can take effect before pointerlockchange hides the overlay.
	const canInteract = () => locked() && joined && connection === "open" && !core.dead && !chatOpen && !failed
		&& picker.hidden && inventoryScreen.hidden && tableScreen.hidden && furnaceScreen.hidden;
	function aimedMobId(block: RayHit | null): number | null {
		return mobBeforeBlock([camera.x, camera.y, camera.z], forward(camera.yaw, camera.pitch), renderMobs, REACH, block);
	}
	function interactLeft(block: RayHit | null, mob: number | null): void {
		if (mob !== null) {
			// Knockback can move the mob off the ray before the next repeat.
			miningStartsAt = performance.now() + LEFT_REPEAT_MS;
			sendPosition();
			transport.send(core.encodeAttack(mob));
		} else if (block && core.gameMode === "creative") {
			setBlock(block.x, block.y, block.z, 0);
		}
	}
	function interact(button: number, repeat = false, shift = keys.has("ShiftLeft") || keys.has("ShiftRight")): void {
		// Recast each time: prediction and camera motion can change the target between repeats.
		const inventory = button === 2 ? core.inventory : [];
		const stack = inventory[selectedSlot];
		const held = stack && items.find(item => item.id === stack.item);
		const hit = aimedBlock(usesFluidSourceRay(held?.name));
		if (button === 2 && !repeat && !usingItem && canInteract()) {
			const targetBlock = hit ? registry[core.getBlock(hit.x, hit.y, hit.z)] : undefined;
			const survival = core.gameMode === "survival";
			const canDraw = held?.name === "bow" && (!survival || inventory.some(slot => slot !== null && slot.item === arrowItemId));
			const canEat = held?.food && survival && core.food < MAX_FOOD;
			const kind = canDraw ? "bow" : canEat ? "food" : null;
			if (stack && kind && blockInteraction(targetBlock?.name, kind === "bow" && shift) !== "open") {
				heldButtons.delete(2);
				transport.send(core.encodeUseItem());
				usingItem = { kind, item: stack.item, count: stack.count, startedAt: performance.now() };
				eatProgress.value = 0;
				eatProgress.hidden = kind !== "food";
				return;
			}
		}
		if (!hit) return;
		if (button === 2) {
			const block = registry[core.getBlock(hit.x, hit.y, hit.z)];
			const open = blockInteraction(block?.name, shift) === "open";
			const above = registry[core.getBlock(hit.x, hit.y + 1, hit.z)];
			if (open || canTill(held?.name, block?.name, above?.name)) {
				if (!repeat) {
					heldButtons.delete(2);
					sendPosition();
					if (open) closePending = updateClosePending(closePending, { type: "use" });
					transport.send(core.encodeUseBlock(hit.x, hit.y, hit.z));
				}
				return;
			}
			if (held?.name === "bucket" || held?.name === "water_bucket" || held?.name === "lava_bucket") {
				if (!repeat) {
					heldButtons.delete(2);
					const target = bucketTarget(held.name, hit, (x, y, z) => registry[core.getBlock(x, y, z)]?.name, shift);
					if (target) {
						sendPosition();
						transport.send(core.encodeUseBucket(...target));
					}
				}
				return;
			}
			if (!selected) return;
			const edit = placementState(registry, selected, hit, camera.yaw,
				(x, y, z) => core.getBlock(x, y, z), target => core.torchPlacement(target));
			if (edit) setBlock(edit.x, edit.y, edit.z, edit.state);
		} else if (button === 1) {
			const item = pickBlockItem(registry[core.getBlock(hit.x, hit.y, hit.z)], items);
			if (!item) return;
			const slot = core.inventory.findIndex((stack, i) => i < 9 && stack?.item === item.id);
			if (slot >= 0) selectSlot(slot);
			else if (core.gameMode === "creative") transport.send(core.encodeCreativeSetSlot(selectedSlot, item.id, 1));
		}
	}
	canvas.addEventListener("mousedown", (e) => {
		if (!canInteract()) return;
		e.preventDefault();
		if (e.button === 0) {
			const repeatAt = performance.now() + LEFT_REPEAT_MS;
			heldButtons.set(0, repeatAt);
			const hit = aimedBlock();
			const mob = aimedMobId(hit);
			if (mob === null) miningStartsAt = 0;
			interactLeft(hit, mob);
		} else {
			if (e.button === 2) heldButtons.set(2, performance.now() + 200);
			interact(e.button, false, e.shiftKey);
		}
	});
	window.addEventListener("mouseup", e => {
		heldButtons.delete(e.button);
		if (e.button === 0) stopDig();
		if (e.button === 2) endUsingItem(Boolean(canInteract()));
	});
	let closedOnHide = false;
	const runPageCacheAction = (action: PageCacheAction): void => {
		switch (action) {
			case "flush":
				transport.flush();
				return;
			case "close":
				transport.close();
				closedOnHide = true;
				return;
			case "reload":
				location.reload();
				return;
			case "resume":
				transport.resume?.();
				return;
		}
	};
	let pageHidden = false;
	window.addEventListener("pagehide", (event) => {
		pageHidden = true;
		audio.setVisible(false);
		const persistence = transport instanceof LocalTransport ? transport.persistence : undefined;
		for (const action of pageCacheActions("pagehide", event.persisted, transport.kind, { persistence })) runPageCacheAction(action);
	});
	window.addEventListener("pageshow", (event) => {
		pageHidden = false;
		audio.setVisible(!document.hidden);
		for (const action of pageCacheActions("pageshow", event.persisted, transport.kind, { closedOnHide })) runPageCacheAction(action);
	});
	document.addEventListener("visibilitychange", () => {
		audio.setVisible(!pageHidden && !document.hidden);
		if (document.visibilityState === "hidden") transport.flush();
	});

	// ---- simulation of the camera ---------------------------------------
	const spawnForAutopilot = () => core.spawn;
	function move(dt: number, timeMs: number): void {
		if (core.dead) return;
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
			const sprint = (core.gameMode !== "survival" || core.food > 6)
				&& (sprinting || pressed(sprintKey(settings, keyboardLocked && document.fullscreenElement === document.documentElement)));
			const jump = pendingJump || pressed(settings.keys.up);
			const state = core.tickPlayer(fwd, strafe, camera.yaw, jump, sprint, pressed(settings.keys.down));
			worldAudio.walk(position, state, connection === "open" && Boolean(fwd || strafe || jump));
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
	const vitals = $("vitals");
	const healthMeter = $("health");
	const airMeter = $("air");
	const foodMeter = $("food");
	const damageFlash = $("damage-flash");
	const respawn = $<HTMLButtonElement>("respawn");
	const hearts = heartStates(core.health).map(() => document.createElement("span"));
	for (const heart of hearts) heart.className = "heart";
	healthMeter.append(...hearts);
	const foodIcons = foodStates(core.food).map(() => document.createElement("span"));
	for (const icon of foodIcons) icon.className = "food";
	foodMeter.append(...foodIcons);
	const bubbles = Array.from({ length: bubbleCount(MAX_AIR) }, () => document.createElement("span"));
	for (const bubble of bubbles) bubble.className = "bubble";
	airMeter.append(...bubbles);
	let previousHealth: number | null = null;

	respawn.addEventListener("click", () => {
		if (!core.dead || connection !== "open") return;
		respawn.disabled = true;
		transport.send(core.encodeRespawn());
	});
	deathScreen.addEventListener("cancel", event => event.preventDefault());

	function syncVitals(): void {
		const { health, air, food, dead, deathCause, gameMode } = core;
		if (dead || (usingItem?.kind === "food" && (food === MAX_FOOD || gameMode !== "survival"))) endUsingItem();
		vitals.hidden = gameMode !== "survival";
		if (!vitals.hidden) {
			healthMeter.setAttribute("aria-valuenow", String(health));
			heartStates(health).forEach((state, i) => { hearts[i].dataset.state = state; });
			foodMeter.setAttribute("aria-valuenow", String(food));
			foodStates(food).forEach((state, i) => { foodIcons[i].dataset.state = state; });
			airMeter.setAttribute("aria-valuenow", String(air));
			airMeter.hidden = air === MAX_AIR;
			const count = bubbleCount(air);
			bubbles.forEach((bubble, i) => { bubble.hidden = i >= count; });
			if (previousHealth !== null && health < previousHealth) {
				damageFlash.getAnimations().forEach(animation => animation.cancel());
				damageFlash.hidden = false;
				damageFlash.animate([{ opacity: 1 }, { opacity: 0 }], 300).onfinish = () => { damageFlash.hidden = true; };
			}
		}
		previousHealth = health;

		if (failed) return;
		if (dead && !deathScreen.open) {
			closeChat(false);
			clearInput();
			hideInventoryScreens();
			picker.hidden = true;
			overlay.hidden = true;
			if (locked()) document.exitPointerLock();
			$("death-cause").textContent = deathCauses[deathCause];
			respawn.disabled = false;
			deathScreen.showModal();
		} else if (!dead && deathScreen.open) {
			deathScreen.close();
			showMenuView("menu");
			if (!autopilot) void requestPointerLock();
		}
	}

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
			closeChat(false);
			fail(`GPUデバイスが失われました: ${renderer.lost}`);
			return;
		}
		let fallbackMeshMs = 0;
		lightMs = 0;
		const frameDtMs = now - last;
		const dt = Math.min(0.1, frameDtMs / 1000);
		last = now;

		const held = joined ? core.inventory[selectedSlot] : null;
		const includeSources = usesFluidSourceRay(items.find(item => item.id === held?.item)?.name);
		const interactive = canInteract();
		const mining = interactive && core.gameMode === "survival" && heldButtons.has(0) && now >= miningStartsAt;
		let block: RayHit | null = null;
		let mob: number | null = null;
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

			renderMobs = core.mobs.map(mob => {
				const elapsed = now - (entityReceivedAt.get(mob.id) ?? now);
				const dx = mob.position[0] - mob.previous[0], dz = mob.position[2] - mob.previous[2];
				const position = interpolateEntity(mob.previous, mob.position, elapsed);
				return {
					id: mob.id,
					kind: mob.kind,
					position,
					yaw: mob.yaw,
					moving: elapsed < 150 && dx * dx + dz * dz >= 0.01 * 0.01,
					hurt: mob.hurt !== 0 && now - (mobHurtAt.get(mob.id) ?? -Infinity) < MOB_HURT_MS,
					fuse: mob.fuse,
					burning: mob.burning,
					light: core.entityLight(position),
				};
			});
			block = aimedBlock();
			mob = aimedMobId(block);
			target = mob !== null ? null : includeSources && !mining ? aimedBlock(true) : block;
		}

		// Include worker replies/uploads between frames as well as this frame's dispatch.
		mainThreadMeshMs = fallbackMeshMs + meshPool.takeMainThreadMs();
		if (usingItem?.kind === "food") eatProgress.value = Math.min(eatProgress.max, now - usingItem.startedAt);
		if (core.gameMode === "survival" && !core.dead) {
			const hit = mob === null ? block : null;
			const blockState = hit ? core.getBlock(hit.x, hit.y, hit.z) : 0;
			const selection = digSelection(selectedSlot, held);
			const ticks = core.miningTicks(blockState, held?.item ?? 0);
			const digTarget = hit && ticks != null ? { x: hit.x, y: hit.y, z: hit.z, state: blockState, ticks, selection } : null;
			const a = dig.active;
			const next = advanceDig(dig, mining, digTarget,
				a ? core.getBlock(a.x, a.y, a.z) : null, now);
			dig = next.state;
			if (connection === "open") for (const command of next.commands) {
				if (command.type === "abort") transport.send(core.encodeDigAbort());
				else { const t = command.target; sendPosition(); transport.send(core.encodeDigStart(t.x,t.y,t.z)); }
			}
		}
		worldAudio.dig(mining ? dig.active : null, now);
		if (interactive) {
			for (const [button, next] of heldButtons) {
				if (now < next) continue;
				if (button === 0) interactLeft(block, mob);
				else interact(button, true);
				heldButtons.set(button, now + (button === 0 ? LEFT_REPEAT_MS : 200));
			}
		}
		tintMap.setWorld(seedReady ? core.seed : null, generator);
		tintMap.update(Math.floor(camera.x / 16), Math.floor(camera.z / 16), viewDistance + 1, tintBudgetMs(frameDtMs));
		renderer.writeTints(tintMap.takeUploads());
		const renderArrows = core.arrows.map(arrow => ({
			position: interpolateEntity(arrow.previous, arrow.position, now - (entityReceivedAt.get(arrow.id) ?? now)),
			velocity: arrow.velocity,
			texture: arrowTexture,
			light: core.entityLight(arrow.position),
		}));
		const renderItems = core.entities.map(entity => {
			const item = items.find(item => item.id === entity.item);
			return {
				position: interpolateEntity(entity.previous, entity.position, now - (entityReceivedAt.get(entity.id) ?? now)),
				texture: itemTextures.get(entity.item) ?? 0,
				flat: item?.texture != null || item?.block == null,
				light: core.entityLight(entity.position),
			};
		});
		const renderPlayers: RenderPlayer[] = core.players.map(({ id, name, previous, position, yaw, pitch }) => {
			const elapsed = now - (playerReceivedAt.get(id) ?? now);
			const dx = position[0] - previous[0], dz = position[2] - previous[2];
			const interpolated = interpolateEntity(previous, position, elapsed);
			return {
				id, name, yaw, pitch,
				position: interpolated,
				moving: elapsed < 150 && dx * dx + dz * dz >= 0.01 * 0.01,
				light: core.entityLight(interpolated),
			};
		});
		const renderDigs = [...remoteDigs.values(), ...(dig.active ? [dig.active] : [])].flatMap(d => {
			const bounds = core.selectionBounds(d.x, d.y, d.z);
			return bounds ? [{ ...d, bounds }] : [];
		});
		const fov = settings.fov * (1 - 0.1 * bowDraw(now) / BOW_MAX_DRAW);
		const dayTime = core.dayTime + partialDayTicks(now, timeReceivedAt, joined && connection === "open");
		if (joined) audio.updateMusic(dayTime);
		explosionParticles = explosionParticles.filter(particle => now < particle.startedAt + particle.lifetime);
		const renderParticles = explosionParticles.filter(particle => now >= particle.startedAt);
		frame = renderer.render(camera, viewDistance, target, fov, dayTime, [...renderArrows, ...renderItems], now, renderDigs, renderMobs, renderParticles, renderPlayers);
		renderedExplosionParticles = renderParticles.length;
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
			audio: audio.stats(),
			chat: { open: chatOpen, lines: chatHistory.map(({ line }) => ({ ...line })) },
			gameMode: core.gameMode,
			health: core.health,
			food: core.food,
			dead: core.dead,
			screen: core.screen,
			entities: core.entities,
			mobs: core.mobs,
			players: core.players.map(({ id, name, position }) => ({ id, name, position })),
			bowDraw: bowDraw(performance.now()),
			arrows: core.arrows.map(({ id, position, velocity }) => ({ id, position, velocity })),
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
			knockbacksReceived,
			lastKnockback,
			explosionsReceived,
			lastExplosion,
			lastExplosionCenter: lastExplosion?.center ?? null,
			explosionParticles: renderedExplosionParticles,
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
			dayTime: core.dayTime,
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
		setDayTime: tick => {
			if (!import.meta.env.DEV || connection !== "open" || !(transport instanceof LocalTransport)
				|| !Number.isInteger(tick) || tick < 0 || tick >= 24000) return false;
			transport.setDayTime(tick);
			return true;
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
	setDayTime: () => false,
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
