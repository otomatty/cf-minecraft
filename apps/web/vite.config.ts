import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	server: { port: 5173, strictPort: true },
	build: { target: "es2022" },
	environments: {
		client: { build: { rollupOptions: { input: { main: "index.html", account: "account.html" } } } },
	},
	worker: { format: "es" },
});
