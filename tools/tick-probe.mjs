// Connects scripted players to a world's Durable Object over WebSocket and
// measures the tick loop from both sides.
//
//   node tools/tick-probe.mjs [--edge http://localhost:5173] [--world probe]
//                             [--players 1] [--seconds 30] [--view 6]
//                             [--mode measure|edit|verify]
//   MC_ACCESS_TOKEN=... node tools/tick-probe.mjs --edge https://<デプロイ先>
//
// measure  players walk and edit blocks; reports tick cadence and traffic
// edit     one player places a marker block, then leaves
// verify   one player joins and checks the marker block is still there
//
// The client-side rate is derived from TimeUpdate packets (one per 20 ticks):
// game ticks advanced divided by wall-clock time between first and last.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClientCore, S2C } from "../apps/web/src/client/client-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const edge = arg("edge", "http://localhost:5173");
const world = arg("world", "probe");
const players = Number(arg("players", "1"));
const seconds = Number(arg("seconds", "30"));
const view = Number(arg("view", "6"));
const mode = arg("mode", "measure");
const accessToken = process.env.MC_ACCESS_TOKEN ?? "";

const clientModule = new WebAssembly.Module(readFileSync(join(root, "apps/web/src/wasm/client.wasm")));
const MARKER = { dx: 2, dy: 3, dz: 1, block: 9 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(index) {
	const core = new ClientCore(new WebAssembly.Instance(clientModule, {}));
	const wsUrl = `${edge.replace(/^http/, "ws")}/ws/${world}`;
	const ws = accessToken
		? new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
		: new WebSocket(wsUrl);
	ws.binaryType = "arraybuffer";
	const p = {
		index,
		core,
		ws,
		joined: false,
		closed: null,
		chunks: 0,
		bytes: 0,
		packets: 0,
		blockUpdates: 0,
		times: [],
		pos: [0, 0, 0],
	};
	p.opened = new Promise((resolve, reject) => {
		ws.onopen = () => {
			ws.send(core.encodeHello(view));
			resolve();
		};
		ws.onerror = () => reject(new Error(`player ${index}: connection failed`));
	});
	ws.onclose = (e) => (p.closed = `${e.code} ${e.reason}`);
	ws.onmessage = (e) => {
		const data = new Uint8Array(e.data);
		p.bytes += data.length;
		p.packets++;
		const id = core.packet(data);
		if (id === S2C.Welcome) {
			p.joined = true;
			const [x, y, z] = core.spawn;
			// Spread the players out so each loads its own area.
			p.pos = [x + index * 300, y + 10, z];
		} else if (id === S2C.ChunkData) p.chunks++;
		else if (id === S2C.BlockUpdate) p.blockUpdates++;
		else if (id === S2C.TimeUpdate) p.times.push([performance.now(), core.gameTime]);
	};
	return p;
}

async function waitFor(check, label, timeoutMs = 15000) {
	const start = performance.now();
	while (!check()) {
		if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await sleep(20);
	}
}

function edgeIsLocal(url) {
	const host = new URL(url).hostname;
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

async function ensureAccess() {
	if (!accessToken && !edgeIsLocal(edge)) {
		console.error("MC_ACCESS_TOKEN が必要です");
		process.exit(1);
	}
	if (!edgeIsLocal(edge) && new URL(edge).protocol !== "https:") {
		console.error("リモート接続先には HTTPS が必要です");
		process.exit(1);
	}
	const res = await fetch(`${edge}/api/worlds/${encodeURIComponent(world)}/metrics`, {
		headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
	});
	if (res.status === 401) {
		console.error("MC_ACCESS_TOKEN が違います");
		process.exit(1);
	}
	if (res.status === 503) {
		console.error("本番の認証設定が未完了です");
		process.exit(1);
	}
	if (!res.ok) {
		console.error(`入場確認に失敗しました (${res.status})`);
		process.exit(1);
	}
}

async function metrics() {
	const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
	return (await fetch(`${edge}/api/worlds/${world}/metrics`, { headers })).json();
}

async function measure() {
	const all = Array.from({ length: players }, (_, i) => connect(i));
	await Promise.all(all.map((p) => p.opened));
	await waitFor(() => all.every((p) => p.joined), "welcome");

	const started = performance.now();
	let step = 0;
	while (performance.now() - started < seconds * 1000) {
		for (const p of all) {
			p.pos[0] += 0.28; // creative sprint-fly is about 1.09 blocks per tick; a brisk walk
			p.ws.send(p.core.encodePos(p.pos[0], p.pos[1], p.pos[2], 0, 0));
			if (step % 5 === 0) {
				const [x, y, z] = p.pos.map(Math.floor);
				p.ws.send(p.core.encodeSetBlock(x + 1, y - 2 - (step % 3), z, 1 + (step % 9)));
			}
		}
		step++;
		await sleep(50);
	}
	const server = await metrics();
	for (const p of all) p.ws.close();

	const perPlayer = all.map((p) => {
		const first = p.times[0];
		const last = p.times[p.times.length - 1];
		const tps = p.times.length > 1 ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000 : 0;
		// Jitter of the once-per-second time packet around its ideal 1000 ms spacing.
		const gaps = p.times.slice(1).map((t, i) => t[0] - p.times[i][0]);
		const worst = gaps.reduce((m, g) => Math.max(m, Math.abs(g - 1000)), 0);
		return {
			tps: Math.round(tps * 1000) / 1000,
			timeUpdates: p.times.length,
			worstSecondDriftMs: Math.round(worst * 10) / 10,
			chunks: p.chunks,
			blockUpdates: p.blockUpdates,
			kibPerSecond: Math.round(p.bytes / 1024 / seconds),
			closed: p.closed,
		};
	});
	console.log(JSON.stringify({ mode, world, players, seconds, view, perPlayer, server }, null, 2));
	const bad = perPlayer.filter((p) => Math.abs(p.tps - 20) > 0.2 || p.closed);
	if (bad.length > 0 || server.ticksSkipped > 0) {
		console.error("FAIL: tick rate off target, ticks skipped, or a connection dropped");
		process.exit(1);
	}
	console.log(`OK: ${players} player(s) held 20 TPS for ${seconds}s`);
}

async function marker(write) {
	const p = connect(0);
	await p.opened;
	await waitFor(() => p.joined, "welcome");
	const [sx, sy, sz] = p.core.spawn.map(Math.floor);
	const [x, y, z] = [sx + MARKER.dx, sy + MARKER.dy, sz + MARKER.dz];
	await waitFor(() => p.core.getBlock(x, y, z) >= 0, "spawn chunk");
	const before = p.core.getBlock(x, y, z);
	if (write) {
		p.ws.send(p.core.encodeSetBlock(x, y, z, MARKER.block));
		await waitFor(() => p.blockUpdates > 0, "server confirmation");
	}
	const after = p.core.getBlock(x, y, z);
	p.ws.close();
	console.log(JSON.stringify({ mode, world, position: [x, y, z], before, after, seed: p.core.seed.toString() }));
	if (after !== MARKER.block) {
		console.error(`FAIL: expected block ${MARKER.block} at the marker position`);
		process.exit(1);
	}
	console.log(write ? "OK: marker placed and confirmed" : "OK: marker survived");
}

await ensureAccess();
if (mode === "measure") await measure();
else await marker(mode === "edit");
