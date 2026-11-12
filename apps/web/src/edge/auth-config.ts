// Kept separate from the auth runtime so routing tests need no Worker runtime.
export interface AuthSecrets {
	BETTER_AUTH_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	TURNSTILE_SECRET_KEY?: string;
	TURNSTILE_SITE_KEY?: string;
}

export function hasAuthSecrets(env: AuthSecrets): boolean {
	return !!(env.BETTER_AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
}
