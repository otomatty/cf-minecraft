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
				getUser: async request => (await getAuth().api.getSession({ headers: request.headers }))?.user ?? null,
			},
			turnstile: (token, ip) => verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip),
		});
	},
} satisfies ExportedHandler<Env>;
