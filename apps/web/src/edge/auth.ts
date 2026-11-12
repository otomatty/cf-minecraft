import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { hasAuthSecrets } from "./auth-config.ts";

export { hasAuthSecrets } from "./auth-config.ts";

export function createAuth(env: Env, origin: string) {
	if (!hasAuthSecrets(env)) throw new Error("Authentication secrets are missing");
	return betterAuth({
		baseURL: origin,
		secret: env.BETTER_AUTH_SECRET,
		database: env.DB,
		socialProviders: {
			google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
		},
		plugins: [captcha({
			provider: "cloudflare-turnstile",
			secretKey: env.TURNSTILE_SECRET_KEY,
			endpoints: ["/sign-in/social"],
		})],
	});
}
