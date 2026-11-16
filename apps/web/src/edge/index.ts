import { WorkerEntrypoint } from "cloudflare:workers";
import { ChunkGenCore, Generator } from "../shared/server-core.ts";
import serverWasm from "../wasm/server.wasm";

let chunkGenerator: ChunkGenCore | undefined;

export class ChunkGen extends WorkerEntrypoint {
	async generate(seed: string, generator: number, cx: number, cz: number): Promise<Uint8Array> {
		if (typeof seed !== "string" || !/^-?\d{1,19}$/.test(seed)) throw new Error("Invalid seed");
		const value = BigInt(seed);
		if (BigInt.asIntN(64, value) !== value) throw new Error("Seed outside i64");
		if (!Object.values(Generator).some(known => known === generator)) throw new Error("Invalid generator");
		// Match the ~30 million block movement boundary, allowing the maximum
		// view distance (12 chunks) beyond the last valid player column.
		if (![cx, cz].every(n => Number.isInteger(n) && Math.abs(n) <= 1_875_011)) throw new Error("Invalid chunk coordinates");
		chunkGenerator ??= ChunkGenCore.fromModule(serverWasm);
		return chunkGenerator.generate(value, generator, cx, cz);
	}
}

import { createAuth, hasAuthSecrets } from "./auth.ts";
import { createDB } from "./db.ts";
import { createLimiter } from "./ratelimit.ts";
import { handle, json } from "./router.ts";
import { verifyTurnstile } from "./turnstile.ts";

export { WorldDO } from "./world-do.ts";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Instantiate lazily: development worlds work without auth secrets or D1 queries.
		let auth: ReturnType<typeof createAuth> | undefined;
		const getAuth = () => auth ??= createAuth(env, new URL(request.url).origin);
		return handle(request, {
			env,
			worlds: ctx.exports.WorldDO,
			db: createDB(env.DB),
			limiter: createLimiter(env),
			auth: {
				handler: request => hasAuthSecrets(env) ? getAuth().handler(request) : Promise.resolve(json({ error: "unavailable" }, 503)),
				getSession: request => getAuth().api.getSession({ headers: request.headers }),
			},
			turnstile: (token, ip) => verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip),
		});
	},
} satisfies ExportedHandler<Env>;
