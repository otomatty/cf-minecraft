import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/edge/index.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
	worker: {
		name: "maincraft",
		compatibilityDate: "2026-11-04",
		entrypoint,
		// Everything else is a static asset (the game client).
		assets: { runWorkerFirst: ["/api/*", "/ws/*"] },
		env: {
			// Debug endpoints burn CPU on request; they exist in development only.
			DEBUG: bindings.text(mode === "development" ? "1" : "0"),
			// Production refuses to create a world until this matches. Not set in dev.
			ACCESS_TOKEN: bindings.secret(),
		},
		exports: {
			WorldDO: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
