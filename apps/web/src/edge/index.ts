// Entry Worker: routes API and WebSocket requests to the world's Durable
// Object. Every other path is served from static assets (the game client)
// without invoking this code.

export { WorldDO } from "./world-do.ts";

const WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_SCENARIO_TICKS = 2000;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// The world class is exported by this same Worker; `ctx.exports` is its typed namespace.
		const worlds = ctx.exports.WorldDO;
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);

		// /ws/<world>: join a world.
		if (parts.length === 2 && parts[0] === "ws") {
			if (!WORLD_NAME.test(parts[1])) return json({ error: "invalid world name" }, 400);
			// Browsers send cookies and credentials on cross-site WebSocket
			// handshakes, so only our own pages may open one.
			const origin = request.headers.get("Origin");
			if (origin !== null && origin !== url.origin) return json({ error: "forbidden origin" }, 403);
			return worlds.getByName(parts[1]).fetch(request);
		}

		if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

		// /api/worlds/<world>/metrics
		if (parts.length === 4 && parts[0] === "api" && parts[1] === "worlds" && parts[3] === "metrics") {
			if (!WORLD_NAME.test(parts[2])) return json({ error: "invalid world name" }, 400);
			return json(await worlds.getByName(parts[2]).metrics());
		}

		// /api/debug/scenario?seed=..&ticks=..   (development builds only)
		if (url.pathname === "/api/debug/scenario") {
			if (env.DEBUG !== "1") return json({ error: "not found" }, 404);
			const seed = url.searchParams.get("seed") ?? "2026";
			const ticks = Number(url.searchParams.get("ticks") ?? "600");
			if (!/^-?\d{1,19}$/.test(seed) || !Number.isInteger(ticks) || ticks < 1 || ticks > MAX_SCENARIO_TICKS) {
				return json({ error: "bad seed or ticks" }, 400);
			}
			return json(await worlds.getByName("debug-scenario").scenario(seed, ticks));
		}

		return json({ error: "not found" }, 404);
	},
} satisfies ExportedHandler<Env>;
