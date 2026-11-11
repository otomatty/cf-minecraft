// Production gate for anything that would create or wake a world Durable Object.
// Local development (DEBUG=1) stays open so the tick probe and the game keep working.
// The shared token is the interim lock from issue #5. Per-user accounts are not this.

export const SESSION_COOKIE = "mc_session";

export interface AccessEnv {
	DEBUG: string;
	ACCESS_TOKEN?: string;
}

export async function accessDenial(env: AccessEnv, presented: string | null): Promise<401 | 503 | null> {
	if (env.DEBUG === "1") return null;
	const expected = env.ACCESS_TOKEN ?? "";
	if (expected === "") return 503;
	if (presented === null || presented === "") return 401;
	return (await sameSecret(presented, expected)) ? null : 401;
}

export function tokenFromRequest(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	if (authorization !== null) {
		return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
	}
	return cookie(request, SESSION_COOKIE);
}

export function sessionCookie(token: string, secure: boolean): string {
	const parts = [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"HttpOnly",
		"Path=/",
		"SameSite=Strict",
		"Max-Age=604800",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

function cookie(request: Request, name: string): string | null {
	const header = request.headers.get("Cookie");
	if (header === null) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() !== name) continue;
		try {
			return decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			return null;
		}
	}
	return null;
}

async function sameSecret(presented: string, expected: string): Promise<boolean> {
	const encode = new TextEncoder();
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encode.encode(presented)),
		crypto.subtle.digest("SHA-256", encode.encode(expected)),
	]);
	return equalBytes(new Uint8Array(left), new Uint8Array(right));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < left.byteLength; i++) diff |= left[i]! ^ right[i]!;
	return diff === 0;
}
