// Account management uses same-origin cookies and JSON APIs directly.
export {};

type Role = "operator" | "player";

interface World {
	name: string;
	role: Role;
	owner: boolean;
}

interface Me {
	open: boolean;
	user: { name: string; email: string } | null;
	canCreateWorlds: boolean;
	turnstileSiteKey: string | null;
}

interface Turnstile {
	render(
		container: HTMLElement,
		options: {
			sitekey: string;
			callback(token: string): void;
			"expired-callback"(): void;
			"error-callback"(): void;
		},
	): string;
	reset(id: string): void;
}

declare global {
	interface Window {
		turnstile?: Turnstile;
	}
}

const content = document.getElementById("account")!;
const status = document.getElementById("status")!;
const next = new URLSearchParams(location.search).get("next");

// Backslashes and control characters can be normalized into a different URL.
function safeNext(value: string | null): string | null {
	if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) {
		return null;
	}
	return new URL(value, location.origin).origin === location.origin ? value : null;
}

const returnPath = safeNext(next);
const callbackURL = returnPath ?? "/account.html";

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function link(text: string, href: string): HTMLAnchorElement {
	const node = element("a", text);
	node.href = href;
	return node;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "通信できません。再度お試しください";
}

function apiErrorMessage(status: number, code?: unknown): string {
	if (status === 503 && code === "sign-out incomplete") {
		return "ログアウトを完了できませんでした。もう一度お試しください";
	}
	switch (status) {
		case 502:
			return "メンバーは削除しましたが、接続中の切断に失敗しました。もう一度削除してください";
		case 503:
			return "本番の認証設定が未完了です";
		case 401:
			return "ログインが必要です。ページを再読み込みしてください";
		case 400:
			return "入力を確認してください。オーナーの削除・降格はできません";
		case 403:
			return "権限がないか、認証に失敗しました";
		case 404:
			return "ワールドが見つかりません";
		case 409:
			return "その名前のワールドはすでにあります";
		case 429:
			return "上限数または操作回数の制限に達しました。しばらく待ってからお試しください";
		default:
			return `操作に失敗しました (${status})`;
	}
}

class APIError extends Error {
	status: number;

	constructor(status: number, code?: unknown) {
		super(apiErrorMessage(status, code));
		this.status = status;
	}
}

async function api<T>(
	path: string,
	method = "GET",
	body?: unknown,
	headers?: Record<string, string>,
): Promise<T> {
	const response = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	}).catch(() => {
		throw new Error("通信できません。再度お試しください");
	});
	if (!response.ok) {
		const body = await response.json().catch(() => null) as { error?: unknown } | null;
		throw new APIError(response.status, body?.error);
	}
	return response.json() as Promise<T>;
}

let turnstileLoading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
	return (turnstileLoading ??= new Promise((resolve, reject) => {
		const script = element("script");
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.onload = () =>
			window.turnstile ? resolve(window.turnstile) : reject(new Error("認証を読み込めません"));
		script.onerror = () =>
			reject(new Error("認証を読み込めません。ページを再読み込みしてください"));
		document.head.append(script);
	}));
}

async function captcha(parent: HTMLElement, sitekey: string, button: HTMLButtonElement) {
	button.disabled = true;
	const container = element("div");
	parent.append(container);
	const turnstile = await loadTurnstile();
	let token = "";
	const clear = () => {
		token = "";
		button.disabled = true;
	};
	const id = turnstile.render(container, {
		sitekey,
		callback: value => {
			token = value;
			button.disabled = false;
		},
		"expired-callback": clear,
		"error-callback": clear,
	});
	return {
		token: () => token,
		reset: () => {
			clear();
			turnstile.reset(id);
		},
	};
}

function input(labelText: string, type = "text") {
	const label = element("label", labelText);
	const field = element("input");
	field.type = type;
	field.required = true;
	label.append(field);
	return { label, field };
}

function notice(parent: HTMLElement): HTMLParagraphElement {
	const node = element("p");
	node.className = "error";
	node.setAttribute("role", "status");
	parent.append(node);
	return node;
}

async function members(parent: HTMLElement, world: World): Promise<void> {
	parent.append(element("h3", "メンバー"));
	const list = element("ul");
	parent.append(list);
	const feedback = notice(parent);
	const path = `/api/worlds/${encodeURIComponent(world.name)}/members`;

	async function refresh() {
		const data = await api<{ members: { email: string; role: Role }[] }>(path);
		list.replaceChildren();
		for (const member of data.members) {
			const row = element("li", `${member.email} (${member.role}) `);
			const remove = element("button", "削除");
			remove.type = "button";
			remove.onclick = async () => {
				remove.disabled = true;
				feedback.textContent = "";
				try {
					await api(`${path}/${encodeURIComponent(member.email)}`, "DELETE");
					await refresh();
				} catch (error) {
					feedback.textContent = message(error);
					remove.disabled = false;
				}
			};
			row.append(remove);
			list.append(row);
		}
	}

	const form = element("form");
	const email = input("メールアドレス", "email");
	email.field.maxLength = 254;
	const roleLabel = element("label", "役割");
	const role = element("select");
	for (const value of ["player", "operator"]) {
		const option = element("option", value);
		option.value = value;
		role.append(option);
	}
	roleLabel.append(role);
	const add = element("button", "追加・役割を更新");
	add.type = "submit";
	form.append(email.label, roleLabel, add);
	parent.append(form);
	form.onsubmit = async event => {
		event.preventDefault();
		add.disabled = true;
		feedback.textContent = "";
		try {
			await api(path, "POST", { email: email.field.value, role: role.value });
			email.field.value = "";
			await refresh();
		} catch (error) {
			feedback.textContent = message(error);
		} finally {
			add.disabled = false;
		}
	};
	try {
		await refresh();
	} catch (error) {
		feedback.textContent = message(error);
	}
}

async function main(): Promise<void> {
	const me = await api<Me>("/api/me");
	status.textContent = "";
	if (me.open) {
		status.textContent = "開発モードではログイン不要です";
		content.append(link("ゲームへ", returnPath ?? "/"));
		return;
	}
	if (!me.user) {
		status.textContent = "ログインしてください";
		const login = element("button", "Google でログイン");
		login.disabled = true;
		content.append(login);
		const feedback = notice(content);
		if (!me.turnstileSiteKey) {
			throw new Error("本番の認証設定が未完了です");
		}
		const widget = await captcha(content, me.turnstileSiteKey, login);
		login.onclick = async () => {
			login.disabled = true;
			feedback.textContent = "";
			try {
				const data = await api<{ url: string }>(
					"/api/auth/sign-in/social",
					"POST",
					{ provider: "google", callbackURL },
					{ "x-captcha-response": widget.token() },
				);
				if (typeof data.url !== "string" || !data.url.startsWith("https://")) {
					throw new Error("ログイン先を取得できません");
				}
				location.href = data.url;
			} catch (error) {
				feedback.textContent = message(error);
				widget.reset();
			}
		};
		return;
	}
	content.append(element("p", `${me.user.name} (${me.user.email})`));
	const logout = element("button", "ログアウト");
	content.append(logout);
	const feedback = notice(content);
	logout.onclick = async () => {
		logout.disabled = true;
		try {
			await api("/api/auth/sign-out", "POST", {});
			location.reload();
		} catch (error) {
			feedback.textContent = message(error);
			logout.disabled = false;
		}
	};
	if (returnPath) {
		content.append(link("ゲームに戻る", returnPath));
	}
	const worlds = element("section");
	worlds.append(element("h2", "自分のワールド"));
	content.append(worlds);
	const worldList = element("div");
	worlds.append(worldList);

	async function refreshWorlds() {
		const data = await api<{ worlds: World[] }>("/api/worlds");
		worldList.replaceChildren();
		if (!data.worlds.length) {
			worldList.append(element("p", "参加しているワールドはありません"));
		}
		for (const world of data.worlds) {
			const row = element("section");
			row.append(
				link(world.name, `/?server=ws&world=${encodeURIComponent(world.name)}`),
				element("span", ` (${world.role}${world.owner ? "・オーナー" : ""})`),
			);
			worldList.append(row);
			if (world.role === "operator") {
				await members(row, world);
			}
		}
	}

	await refreshWorlds();
	if (me.canCreateWorlds) {
		const section = element("section");
		section.append(element("h2", "ワールドを作成"));
		content.append(section);
		section.append(
			element(
				"p",
				"名前は半角英小文字・数字で始まる1〜32文字です。" +
					"途中に - と _ も使えます。作成は1人5個までです。",
			),
		);
		const form = element("form");
		const name = input("名前");
		name.field.pattern = "[a-z0-9][a-z0-9_\\-]{0,31}";
		name.field.maxLength = 32;
		const create = element("button", "作成");
		create.type = "submit";
		create.disabled = true;
		form.append(name.label, create);
		section.append(form);
		const feedback = notice(section);
		if (!me.turnstileSiteKey) {
			throw new Error("本番の認証設定が未完了です");
		}
		const widget = await captcha(form, me.turnstileSiteKey, create);
		form.onsubmit = async event => {
			event.preventDefault();
			if (!widget.token()) {
				return;
			}
			create.disabled = true;
			feedback.textContent = "";
			try {
				await api("/api/worlds", "POST", {
					name: name.field.value,
					turnstileToken: widget.token(),
				});
				name.field.value = "";
				await refreshWorlds();
			} catch (error) {
				feedback.textContent =
					error instanceof APIError && error.status === 400
						? "名前は半角英小文字・数字で始まる1〜32文字にしてください（- と _ も使えます）"
						: message(error);
			} finally {
				widget.reset();
			}
		};
	}
}

main().catch(error => {
	status.textContent = message(error);
	status.className = "error";
});
