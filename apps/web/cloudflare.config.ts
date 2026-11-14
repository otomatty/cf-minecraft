import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/edge/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
	worker: {
		name: "minecraft",
		compatibilityDate: "2026-11-04",
		entrypoint,
		// Everything else is a static asset (the game client).
		assets: { runWorkerFirst: ["/api/*", "/ws/*"] },
		env: {
			// Debug endpoints burn CPU on request; they exist in development only.
			DEBUG: bindings.text(mode === "development" ? "1" : "0"),
			// Operator access for production probes.
			ACCESS_TOKEN: bindings.secret(),
			DB: bindings.d1({ name: "cf-minecraft" }),
			IP_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 120, period: 60 } }),
			AUTH_LIMIT: bindings.rateLimit({ namespace: "1002", simple: { limit: 20, period: 60 } }),
			USER_LIMIT: bindings.rateLimit({ namespace: "1003", simple: { limit: 30, period: 60 } }),
			BETTER_AUTH_SECRET: bindings.secret(),
			GOOGLE_CLIENT_ID: bindings.secret(),
			GOOGLE_CLIENT_SECRET: bindings.secret(),
			TURNSTILE_SECRET_KEY: bindings.secret(),
			TURNSTILE_SITE_KEY: bindings.secret(),
			WORLD_CREATORS: bindings.secret(),
		},
		exports: {
			WorldDO: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
