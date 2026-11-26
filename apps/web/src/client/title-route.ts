export function gameRedirect(search: string): string | null {
	const params = new URLSearchParams(search);
	return ["server", "world", "view", "gen", "seed", "time", "autopilot"].some(key => params.has(key))
		? "/play.html" + search
		: null;
}

// Reject characters that browsers can normalize into a different URL.
export function safeNext(value: string | null): string | null {
	if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f\s]/u.test(value)) {
		return null;
	}
	return value;
}

const thumbnailColors = ["#829fba", "#769262", "#937d67", "#557e91", "#889184", "#a49b7d"];

export function thumbColor(name: string): string {
	let hash = 0;
	for (const character of name) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
	return thumbnailColors[hash % thumbnailColors.length];
}

interface Session {
	open?: boolean;
	user?: object | null;
}

export function hasPlaySession(me: Session): boolean {
	return me.open === true || Boolean(me.user);
}

export function titleScreen(me: Session, installed: boolean): "login" | "textures" | "menu" {
	if (!hasPlaySession(me)) return "login";
	return installed ? "menu" : "textures";
}
