const SITEVERIFY_TIMEOUT_MS = 10_000;

export async function verifyTurnstile(
	secret: string,
	token: string,
	ip: string | null,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	if (!secret || !token) return false;
	const body = new URLSearchParams({ secret, response: token });
	if (ip) body.set("remoteip", ip);
	try {
		const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body,
			signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
		});
		if (!response.ok) return false;
		const result: unknown = await response.json();
		return (
			typeof result === "object" &&
			result !== null &&
			"success" in result &&
			result.success === true
		);
	} catch {
		return false;
	}
}
