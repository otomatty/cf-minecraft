// The operator credential is accepted only in an Authorization Bearer header.
export function tokenFromRequest(request: Request): string | null {
	const authorization = request.headers.get("Authorization");
	return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export async function isOperator(request: Request, expected?: string): Promise<boolean> {
	const presented = tokenFromRequest(request);
	return !!expected && !!presented && sameSecret(presented, expected);
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
