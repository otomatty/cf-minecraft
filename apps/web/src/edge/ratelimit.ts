export type LimitName = "IP_LIMIT" | "AUTH_LIMIT" | "USER_LIMIT";
export type Limiter = (name: LimitName, key: string) => Promise<boolean>;

export function createLimiter(env: Pick<Env, LimitName | "DEBUG">): Limiter {
	return async (name, key) => env.DEBUG === "1" || (await env[name].limit({ key })).success;
}

export function clientIP(request: Request): string {
	return request.headers.get("CF-Connecting-IP") || "unknown";
}
