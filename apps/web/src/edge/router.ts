import { isOperator, tokenFromRequest } from "./access.ts";
import { hasAuthSecrets } from "./auth-config.ts";
import type { AuthSecrets } from "./auth-config.ts";
import type { WorldDB } from "./db.ts";
import { clientIP } from "./ratelimit.ts";
import type { Limiter } from "./ratelimit.ts";

const WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface User {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image?: string | null;
}

export interface RouterDeps {
	env: AuthSecrets & { DEBUG: string; ACCESS_TOKEN?: string; WORLD_CREATORS?: string };
	worlds: {
		getByName(name: string): {
			fetch(request: Request): Promise<Response>;
			metrics(): Promise<unknown>;
			revoke(userId: string): Promise<number>;
			scenario(seed: string, ticks: number): Promise<unknown>;
		};
	};
	auth: {
		handler(request: Request): Promise<Response>;
		getUser(request: Request): Promise<User | null>;
	};
	db: WorldDB;
	limiter: Limiter;
	turnstile(token: string, ip: string | null): Promise<boolean>;
}

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const error = (message: string, status: number) => json({ error: message }, status);
const limited = () => error("rate limited", 429);

function canCreate(env: RouterDeps["env"], user: User | null): boolean {
	return (
		!!user?.emailVerified &&
		(env.WORLD_CREATORS ?? "")
			.split(",")
			.some(email => email.trim().toLowerCase() === user.email.toLowerCase())
	);
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
	// Read at most 2KB, including for requests with no Content-Length.
	if (!request.body) {
		return null;
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > 2048) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

export async function handle(request: Request, deps: RouterDeps): Promise<Response> {
	const { env, worlds, auth, db } = deps;
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	const open = env.DEBUG === "1";
	const ip = clientIP(request);
	const limit: Limiter = async (name, key) => open || deps.limiter(name, key);

	// Preserve the development-only scenario endpoint, including its method check.
	if (url.pathname === "/api/debug/scenario") {
		if (request.method !== "GET") {
			return error("method not allowed", 405);
		}
		if (!open) {
			return error("not found", 404);
		}
		const seed = url.searchParams.get("seed") ?? "2026";
		const ticks = Number(url.searchParams.get("ticks") ?? "600");
		if (!/^-?\d{1,19}$/.test(seed) || !Number.isInteger(ticks) || ticks < 1 || ticks > 2000) {
			return error("bad seed or ticks", 400);
		}
		return json(await worlds.getByName("debug-scenario").scenario(seed, ticks));
	}

	const ws = parts[0] === "ws" && parts.length === 2;
	if (ws && !WORLD_NAME.test(parts[1])) {
		return error("invalid world name", 400);
	}
	if (ws && request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) {
		return error("forbidden origin", 403);
	}
	if ((parts[0] === "api" || parts[0] === "ws") && !(parts[0] === "api" && parts[1] === "debug")) {
		if (!(await limit("IP_LIMIT", ip))) {
			return limited();
		}
	}
	if (
		(request.method === "POST" || request.method === "DELETE") &&
		request.headers.get("Origin") !== url.origin
	) {
		return error("forbidden origin", 403);
	}

	const authRoute = url.pathname.startsWith("/api/auth/");
	if (authRoute) {
		if (
			!(request.method === "GET" && url.pathname === "/api/auth/get-session") &&
			!(await limit("AUTH_LIMIT", ip))
		) {
			return limited();
		}
		if (!hasAuthSecrets(env)) {
			return error("unavailable", 503);
		}
		const signingOut = request.method === "POST" && url.pathname === "/api/auth/sign-out";
		const signingOutUser = signingOut ? await auth.getUser(request) : null;
		const response = await auth.handler(request);
		if (response.ok && signingOutUser?.emailVerified) {
			const memberships = await db.worlds(signingOutUser.id, signingOutUser.email.toLowerCase());
			await Promise.allSettled(
				memberships.map(async world => {
					await worlds.getByName(world.name).revoke(signingOutUser.id);
				}),
			);
		}
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "no-store");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	const me = url.pathname === "/api/me";
	const worldRoute = parts[0] === "api" && parts[1] === "worlds";
	if (!me && !worldRoute && !ws) {
		return error("not found", 404);
	}
	if (!open && !hasAuthSecrets(env)) {
		return error("unavailable", 503);
	}
	const user = hasAuthSecrets(env) ? await auth.getUser(request) : null;
	if (me) {
		if (request.method !== "GET") {
			return error("method not allowed", 405);
		}
		return json({
			open,
			user: user
				? { id: user.id, name: user.name, email: user.email, image: user.image ?? null }
				: null,
			canCreateWorlds: canCreate(env, user),
			turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
		});
	}

	const metrics = worldRoute && parts.length === 4 && parts[3] === "metrics";
	if (metrics && request.method !== "GET") {
		return error("method not allowed", 405);
	}
	let ops = false;
	if (ws || metrics) {
		ops = await isOperator(request, env.ACCESS_TOKEN);
		if (tokenFromRequest(request) !== null && !ops && !(await limit("AUTH_LIMIT", ip))) {
			return limited();
		}
	}

	const name = ws ? parts[1] : parts[2];
	if (name !== undefined && !WORLD_NAME.test(name)) {
		return error("invalid world name", 400);
	}
	if (ws || metrics) {
		if (!open && !ops) {
			if (!user) {
				return error("unauthorized", 401);
			}
			if (!(await db.world(name))) {
				return error("not found", 404);
			}
			const member = user.emailVerified ? await db.member(name, user.email.toLowerCase()) : null;
			if (!member || (metrics && member.role !== "operator")) {
				return error("forbidden", 403);
			}
		}
		if (metrics) {
			return json(await worlds.getByName(name).metrics());
		}
		const headers = new Headers(request.headers);
		headers.delete("X-MC-User");
		headers.set(
			"X-MC-User",
			ops ? `ops:${crypto.randomUUID()}` : user ? user.id : `dev:${crypto.randomUUID()}`,
		);
		return worlds.getByName(name).fetch(new Request(request, { headers }));
	}

	if (worldRoute && parts.length === 3 && request.method === "GET" && open) {
		return json({ name, role: "operator", owner: false });
	}
	if (!user) {
		return error("unauthorized", 401);
	}
	if (!user.emailVerified) {
		return error("forbidden", 403);
	}
	const email = user.email.toLowerCase();
	if (request.method === "POST" || request.method === "DELETE") {
		if (!(await limit("USER_LIMIT", user.id))) {
			return limited();
		}
	}

	if (parts.length === 2) {
		if (request.method === "GET") {
			return json({ worlds: await db.worlds(user.id, email) });
		}
		if (request.method !== "POST") {
			return error("method not allowed", 405);
		}
		if (!canCreate(env, user)) {
			return error("forbidden", 403);
		}
		const input = await body(request);
		if (
			!input ||
			typeof input.name !== "string" ||
			!WORLD_NAME.test(input.name) ||
			typeof input.turnstileToken !== "string"
		) {
			return error("bad request", 400);
		}
		if (!(await deps.turnstile(input.turnstileToken, request.headers.get("CF-Connecting-IP")))) {
			return error("forbidden", 403);
		}
		if (await db.world(input.name)) {
			return error("already exists", 409);
		}
		const result = await db.createWorld(input.name, user.id, email);
		if (result === "exists") {
			return error("already exists", 409);
		}
		if (result === "limit") {
			return limited();
		}
		return json({ name: input.name }, 201);
	}

	if (parts.length > 5 || (parts.length >= 4 && parts[3] !== "members")) {
		return error("not found", 404);
	}

	const world = await db.world(name);
	if (!world) {
		return error("not found", 404);
	}
	const member = await db.member(name, email);
	if (!member) {
		return error("forbidden", 403);
	}
	if (parts.length === 3) {
		if (request.method !== "GET") {
			return error("method not allowed", 405);
		}
		return json({ name, role: member.role, owner: world.owner_id === user.id });
	}

	if (member.role !== "operator") {
		return error("forbidden", 403);
	}
	if (parts.length === 4 && request.method === "GET") {
		return json({ members: await db.members(name) });
	}
	if (parts.length === 4 && request.method === "POST") {
		const input = await body(request);
		if (
			!input ||
			typeof input.email !== "string" ||
			input.email.length > 254 ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
			(input.role !== "operator" && input.role !== "player")
		) {
			return error("bad request", 400);
		}
		const target = input.email.toLowerCase();
		if (target === world.owner_email && input.role !== "operator") {
			return error("owner cannot be demoted", 400);
		}
		if (!(await db.putMember(name, target, input.role))) {
			return limited();
		}
		return json({ email: target, role: input.role });
	}

	if (parts.length === 5 && request.method === "DELETE") {
		let target: string;
		try {
			target = decodeURIComponent(parts[4]).toLowerCase();
		} catch {
			return error("bad request", 400);
		}
		if (target === world.owner_email) {
			return error("owner cannot be removed", 400);
		}
		await db.deleteMember(name, target);
		const userIds = await db.userIds(target);
		await Promise.allSettled(
			userIds.map(async id => {
				await worlds.getByName(name).revoke(id);
			}),
		);
		return json({});
	}

	return error("method not allowed", 405);
}
