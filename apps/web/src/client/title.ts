import { installPack, loadInstalledPack } from "./texture-pack-settings.ts";
import { packLabel, packMissingNotice, type TexturePack } from "./texture-pack.ts";
import { gameRedirect, hasPlaySession, safeNext, thumbColor, titleScreen } from "./title-route.ts";
import type { TextureLayout } from "./textures.ts";
import type { createTitleBackground } from "./title-background.ts";

type Role = "operator" | "player";
type GameMode = "creative" | "survival";

const gameModeText: Record<GameMode, string> = {
	creative: "クリエイティブ",
	survival: "サバイバル",
};

interface World {
	name: string;
	role: Role;
	owner: boolean;
	gameMode: GameMode;
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
			theme: "dark";
			size: "flexible";
			callback(token: string): void;
			"expired-callback"(): void;
			"error-callback"(): void;
		},
	): string;
	reset(id: string): void;
	remove?(id: string): void;
}

declare global {
	interface Window {
		turnstile?: Turnstile;
	}
}

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

function gameModeSelect(mode: GameMode = "creative") {
	const label = element("label", "ゲームモード");
	const field = element("select");
	for (const [value, text] of Object.entries(gameModeText)) {
		const option = element("option", text);
		option.value = value;
		field.append(option);
	}
	field.value = mode;
	label.append(field);
	return { label, field };
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
			if (code === "game mode update failed") {
				return "ゲームモードは保存されました。次の接続時にワールドへ反映されます";
			}
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

type Screen = "loading" | "error" | "login" | "textures" | "menu" | "worlds" | "members" | "create";

function start(): void {
	const panel = document.getElementById("panel")!;
	const status = document.getElementById("status")!;
	const userDisplay = document.getElementById("user")!;
	const canvas = document.querySelector<HTMLCanvasElement>("#title-background")!;
	const returnPath = safeNext(new URLSearchParams(location.search).get("next"));
	let screen: Screen = "loading";
	let me: Me | undefined;
	let layout: TextureLayout;
	let layoutLoading: Promise<TextureLayout> | undefined;
	let pack: TexturePack | undefined;
	let background: Awaited<ReturnType<typeof createTitleBackground>>;
	let backgroundLifetime: AbortController;
	let applied = false;
	let worlds: World[] | undefined;
	let selected: string | undefined;
	let worldError = "";
	let startupError = "";
	let packStorageError = "";
	let generation = 0;
	let disposeCaptcha: (() => void) | undefined;

	// Give the title UI a paint opportunity before loading rendering code or WASM.
	const afterPaint = new Promise<void>(resolve => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});

	function loadLayout(): Promise<TextureLayout> {
		return layoutLoading ??= afterPaint.then(async () => {
			const [{ ClientCore, gameTextureLayout }, { default: url }] = await Promise.all([
				import("./client-core.ts"), import("../wasm/client.wasm?url"),
			]);
			return gameTextureLayout(await ClientCore.load(url));
		}).catch(error => {
			layoutLoading = undefined;
			throw error;
		});
	}

	function setPack(next: TexturePack | undefined): void {
		pack = next;
		if (pack) background?.setPack(pack);
	}

	async function startBackground(): Promise<void> {
		const lifetime = new AbortController();
		backgroundLifetime = lifetime;
		const { signal } = lifetime;
		try {
			await afterPaint;
			if (signal.aborted) return;
			const [{ createTitleBackground }, textureLayout] = await Promise.all([
				import("./title-background.ts"), loadLayout(),
			]);
			if (signal.aborted) return;
			const current = await createTitleBackground(canvas, textureLayout, signal);
			if (signal.aborted) return;
			background = current;
			if (pack) background?.setPack(pack);
		} catch (error) {
			if (!signal.aborted) {
				console.warn("タイトル背景を描画できません", error);
				lifetime.abort();
			}
		}
	}

	window.addEventListener("pagehide", () => {
		backgroundLifetime.abort();
		background = undefined;
	});
	window.addEventListener("pageshow", event => {
		if (!event.persisted) return;
		pack = undefined;
		void initialize();
		void startBackground();
	});

	function button(text: string, color = "green", action?: () => void): HTMLButtonElement {
		const node = element("button", text);
		node.type = "button";
		node.className = `btn ${color}`;
		if (action) node.onclick = action;
		return node;
	}
	function actionLink(text: string, href: string, color = "green") {
		const node = link(text, href);
		node.className = `btn ${color}`;
		return node;
	}
	function notice(parent: HTMLElement) {
		const node = element("p");
		node.className = "error";
		node.setAttribute("role", "status");
		parent.append(node);
		return node;
	}
	function input(text: string, type = "text") {
		const label = element("label", text);
		const field = element("input");
		field.type = type;
		field.required = true;
		label.append(field);
		return { label, field };
	}
	function worldInput(text: string) {
		const value = input(text);
		value.field.pattern = "[a-z0-9][a-z0-9_\\-]{0,31}";
		value.field.maxLength = 32;
		return value;
	}
	function go(next: Screen) {
		screen = next;
		render();
	}
	function heading(text: string, back?: Screen) {
		const row = element("div");
		row.className = "heading-row";
		const title = element("h2", text);
		title.tabIndex = -1;
		row.append(title);
		if (back) row.append(button("← 戻る", "outline", () => go(back)));
		panel.append(row);
		return title;
	}
	function worldURL(name: string) {
		return `/play.html?server=ws&world=${encodeURIComponent(name)}`;
	}
	function roleText(world: World) {
		return world.role + (world.owner ? "・オーナー" : "");
	}

	async function captcha(parent: HTMLElement, submit: HTMLButtonElement, feedback: HTMLElement) {
		submit.disabled = true;
		const container = element("div");
		container.className = "captcha";
		parent.append(container);
		const current = generation;
		if (!me?.turnstileSiteKey) {
			feedback.textContent = "本番の認証設定が未完了です";
			return;
		}
		try {
			const turnstile = await loadTurnstile();
			if (current !== generation) return;
			let token = "";
			let busy = false;
			const clear = () => { token = ""; submit.disabled = true; };
			const id = turnstile.render(container, {
				sitekey: me.turnstileSiteKey,
				theme: "dark",
				size: "flexible",
				callback: value => { token = value; submit.disabled = busy; },
				"expired-callback": clear,
				"error-callback": clear,
			});
			disposeCaptcha = () => turnstile.remove?.(id);
			return {
				token: () => token,
				begin: () => { busy = true; submit.disabled = true; },
				reset: () => {
					if (current !== generation) return;
					busy = false;
					clear();
					turnstile.reset(id);
				},
			};
		} catch (error) {
			if (current === generation) feedback.textContent = message(error);
		}
	}

	async function refreshWorlds(preferred?: string): Promise<boolean> {
		try {
			const data = await api<{ worlds: World[] }>("/api/worlds");
			worlds = data.worlds;
			const candidate = preferred ?? selected;
			selected = worlds.find(world => world.name === candidate)?.name ?? worlds[0]?.name;
			worldError = "";
			return true;
		} catch (error) {
			worlds = undefined;
			worldError = message(error);
			if (error instanceof APIError && error.status === 401) {
				me = me ? { ...me, user: null, open: false } : undefined;
				updateUser();
				go("login");
			}
			return false;
		}
	}

	async function login(parent: HTMLElement, current: number) {
		parent.append(element("p", "遊ぶには Google アカウントでログインしてください。マルチプレイでは、招待されたメールアドレスのアカウントを使います。"));
		const slot = element("div");
		const submit = button("Google でログイン");
		parent.append(slot, submit);
		const feedback = notice(parent);
		const widget = await captcha(slot, submit, feedback);
		if (!widget || current !== generation) return;
		submit.onclick = async () => {
			if (!widget.token() || submit.disabled) return;
			widget.begin();
			submit.textContent = "Google に移動しています…";
			feedback.textContent = "";
			try {
				const data = await api<{ url: string }>("/api/auth/sign-in/social", "POST",
					{ provider: "google", callbackURL: returnPath ?? "/" },
					{ "x-captcha-response": widget.token() });
				if (typeof data.url !== "string" || !data.url.startsWith("https://")) throw new Error("ログイン先を取得できません");
				location.href = data.url;
			} catch (error) {
				feedback.textContent = message(error);
				submit.textContent = "Google でログイン";
				widget.reset();
			}
		};
	}

	function updateMultiplayerBadge() {
		const multiplayer = panel.querySelector('[data-role="multiplayer"]');
		if (!multiplayer) return;
		let badge = multiplayer.querySelector(".badge");
		if (me!.open || !worlds) {
			badge?.remove();
			return;
		}
		if (!badge) {
			badge = element("span");
			badge.className = "badge";
			multiplayer.append(badge);
		}
		badge.textContent = `${worlds.length} ワールド`;
	}

	function openMenu(): void {
		go("menu");
		if (!me!.open && !worlds) {
			void refreshWorlds().then(() => {
				if (screen === "menu") updateMultiplayerBadge();
				else if (screen === "worlds") render();
			});
		}
	}

	function textures(): void {
		const template = document.querySelector<HTMLTemplateElement>("#texture-install")!;
		panel.append(template.content.cloneNode(true));
		const file = panel.querySelector<HTMLInputElement>("#texture-file")!;
		const choose = panel.querySelector<HTMLButtonElement>("#texture-choose")!;
		const drop = panel.querySelector<HTMLElement>("#texture-drop")!;
		const choice = panel.querySelector<HTMLElement>("#texture-choice")!;
		const progress = panel.querySelector<HTMLElement>("#texture-progress")!;
		const failure = panel.querySelector<HTMLElement>("#texture-error")!;
		const bar = progress.querySelector("progress")!;
		const downloadDetails = panel.querySelectorAll<HTMLElement>("[data-download-detail], #texture-step-one");
		const check = panel.querySelector<SVGElement>("#texture-step-check")!;
		const storageWarning = packStorageError ? element("p", packStorageError) : undefined;
		if (storageWarning) {
			storageWarning.className = "error";
			storageWarning.setAttribute("role", "alert");
			panel.append(storageWarning);
		}
		const back = pack ? button("メニューに戻る", "outline", () => go("menu")) : undefined;
		if (back) panel.append(back);
		const current = generation;
		let busy = false;
		let dragDepth = 0;

		async function install(chosen: File): Promise<void> {
			if (busy) return;
			busy = true;
			storageWarning?.remove();
			file.value = "";
			choose.hidden = choice.hidden = failure.hidden = true;
			if (back) back.disabled = true;
			drop.classList.remove("invalid", "dragging");
			downloadDetails.forEach(detail => { detail.hidden = true; });
			check.removeAttribute("hidden");
			progress.querySelector(".texture-filename")!.textContent = chosen.name;
			bar.removeAttribute("value");
			progress.hidden = false;
			try {
				setPack(await installPack(chosen, layout, (done, total) => {
					if (!total) return;
					bar.max = total;
					bar.value = done;
				}));
				applied = true;
				if (current === generation) openMenu();
			} catch (error) {
				progress.hidden = true;
				downloadDetails.forEach(detail => { detail.hidden = false; });
				check.setAttribute("hidden", "");
				failure.querySelector(".texture-filename")!.textContent = chosen.name;
				failure.querySelector("#texture-error-reason")!.textContent = message(error);
				drop.classList.add("invalid");
				failure.hidden = choose.hidden = false;
				choose.textContent = "別のファイルを選ぶ";
				if (back) back.disabled = false;
				choose.focus();
			} finally {
				busy = false;
			}
		}

		choose.onclick = () => file.click();
		file.onchange = () => { if (file.files?.[0]) void install(file.files[0]); };
		drop.ondragenter = event => {
			event.preventDefault();
			dragDepth++;
			if (!busy) drop.classList.add("dragging");
		};
		drop.ondragleave = () => {
			if (--dragDepth <= 0) drop.classList.remove("dragging");
		};
		drop.ondragover = event => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
		};
		drop.ondrop = event => {
			event.preventDefault();
			dragDepth = 0;
			drop.classList.remove("dragging");
			const chosen = event.dataTransfer?.files[0];
			if (chosen) void install(chosen);
		};
	}

	function menu() {
		if (applied) {
			const confirmation = element("p", "テクスチャを適用しました");
			confirmation.setAttribute("role", "status");
			panel.append(confirmation);
			applied = false;
		}
		if (returnPath) panel.append(actionLink("ゲームに戻る", returnPath));
		panel.append(actionLink("シングルプレイ", "/play.html"));
		const multiplayer = button("マルチプレイ", "blue", () => go("worlds"));
		multiplayer.dataset.role = "multiplayer";
		panel.append(multiplayer);
		updateMultiplayerBadge();
		if (!me!.open) {
			const logout = button("ログアウト", "gray");
			panel.append(logout);
			const feedback = notice(panel);
			logout.onclick = async () => {
				logout.disabled = true;
				feedback.textContent = "";
				try {
					await api("/api/auth/sign-out", "POST", {});
					location.reload();
				} catch (error) {
					feedback.textContent = message(error);
					logout.disabled = false;
				}
			};
		} else {
			const note = element("p", "開発モード: ログインなしで動いています");
			note.className = "muted small";
			panel.append(note);
		}
		const summary = element("div");
		summary.className = "pack-summary";
		const label = element("div");
		label.append(element("small", "テクスチャ"), element("p", packLabel(pack!)));
		const missing = packMissingNotice(pack!, layout.names);
		if (missing) {
			const notice = element("small", missing);
			notice.dataset.packMissing = "";
			notice.className = "muted";
			label.append(notice);
		}
		summary.append(label, button("入れ直す", "outline", () => go("textures")));
		panel.append(element("hr"), summary);
	}

	function worldList() {
		if (me!.open) {
			const form = element("form");
			const name = worldInput("ワールド名");
			name.field.value = "lobby";
			const join = button("参加する");
			join.type = "submit";
			form.append(name.label, join);
			form.onsubmit = event => { event.preventDefault(); location.href = worldURL(name.field.value); };
			panel.append(form);
			return;
		}
		if (!worlds) {
			if (worldError) {
				notice(panel).textContent = worldError;
				panel.append(button("再読み込み", "gray", () => {
					worldError = "";
					go("worlds");
					void refreshWorlds().then(() => { if (screen === "worlds") render(); });
				}));
			} else panel.append(element("p", "読み込み中…"));
		} else if (!worlds.length) {
			panel.append(element("p", "参加しているワールドはありません。招待されたメールアドレスでログインしているか確かめてください。"));
		}
		const grid = element("div");
		grid.className = "world-grid";
		const detail = element("div");
		detail.className = "world-detail";
		const cards: HTMLButtonElement[] = [];
		function selectWorld(world: World, clicked = false) {
			selected = world.name;
			cards.forEach((card, index) => card.setAttribute("aria-pressed", String(worlds![index].name === selected)));
			const text = element("div");
			text.className = "world-info";
			text.append(element("small", "マルチプレイ"), element("h3", world.name),
				element("p", roleText(world)), element("p", `ゲームモード ${gameModeText[world.gameMode]}`));
			const actions = element("div");
			actions.className = "actions";
			if (world.role === "operator") actions.append(button("メンバー", "outline", () => go("members")));
			actions.append(actionLink("参加する", worldURL(world.name)));
			detail.replaceChildren(text, actions);
			if (clicked) {
				const bounds = detail.getBoundingClientRect();
				if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
					const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
					detail.scrollIntoView({ block: "nearest", behavior });
				}
			}
		}
		for (const world of worlds ?? []) {
			const card = button("", "world-card", () => selectWorld(world, true));
			const thumb = element("span");
			thumb.className = "thumbnail";
			thumb.style.backgroundColor = thumbColor(world.name);
			thumb.setAttribute("aria-hidden", "true");
			const name = element("span", world.name);
			name.className = "world-name";
			card.append(thumb, name, element("small", `${roleText(world)} · ${gameModeText[world.gameMode]}`));
			cards.push(card);
			grid.append(card);
		}
		if (me!.canCreateWorlds) {
			const create = button("＋ 新しいワールド", "world-card create-card", () => go("create"));
			create.append(element("small", "作成は1人5個まで"));
			grid.append(create);
		}
		panel.append(grid, detail);
		const world = worlds?.find(world => world.name === selected);
		if (world) selectWorld(world);
	}

	async function members(world: World, current: number) {
		const worldPath = `/api/worlds/${encodeURIComponent(world.name)}`;
		const modeForm = element("form");
		const mode = gameModeSelect(world.gameMode);
		const change = button("変更");
		change.type = "submit";
		modeForm.append(mode.label, element("p", "接続中のプレイヤーはいったん切断され、再接続されます"), change);
		panel.append(modeForm);
		const modeFeedback = notice(panel);
		modeForm.onsubmit = async event => {
			event.preventDefault();
			if (change.disabled) return;
			const gameMode = mode.field.value as GameMode;
			change.disabled = mode.field.disabled = true;
			modeFeedback.textContent = "";
			try {
				const updated = await api<{ gameMode: GameMode }>(worldPath, "PATCH", { gameMode });
				world.gameMode = updated.gameMode;
				modeFeedback.textContent = `ゲームモードを${gameModeText[updated.gameMode]}に変更しました`;
			} catch (error) {
				if (error instanceof APIError && error.status === 502) world.gameMode = gameMode;
				modeFeedback.textContent = message(error);
			} finally {
				change.disabled = mode.field.disabled = false;
			}
		};
		const list = element("ul");
		list.className = "member-list";
		list.append(element("li", "読み込み中…"));
		panel.append(list);
		const feedback = notice(panel);
		const path = `${worldPath}/members`;
		async function refresh() {
			const data = await api<{ members: { email: string; role: Role }[] }>(path);
			if (current !== generation) return;
			list.replaceChildren();
			if (!data.members.length) list.append(element("li", "メンバーはいません"));
			for (const member of data.members) {
				const row = element("li");
				const identity = element("span", member.email);
				identity.append(element("small", member.role));
				const remove = button("削除", "outline");
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
				row.append(identity, remove);
				list.append(row);
			}
		}
		const form = element("form");
		const email = input("メールアドレス", "email");
		email.field.maxLength = 254;
		const label = element("label", "役割");
		const role = element("select");
		for (const value of ["player", "operator"]) {
			const option = element("option", value);
			option.value = value;
			role.append(option);
		}
		label.append(role);
		const add = button("追加・役割を更新");
		add.type = "submit";
		form.append(email.label, label, add);
		panel.append(form);
		form.onsubmit = async event => {
			event.preventDefault();
			add.disabled = true;
			feedback.textContent = "";
			try {
				await api(path, "POST", { email: email.field.value, role: role.value });
				email.field.value = "";
				await refresh();
			} catch (error) { feedback.textContent = message(error); }
			finally { add.disabled = false; }
		};
		try { await refresh(); }
		catch (error) {
			list.replaceChildren();
			feedback.textContent = message(error);
		}
	}

	async function createWorld(current: number) {
		panel.append(element("p", "名前は半角英小文字・数字で始まる1〜32文字です。途中に - と _ も使えます。作成は1人5個までです。"));
		const form = element("form");
		const name = worldInput("名前");
		const mode = gameModeSelect();
		const slot = element("div");
		const submit = button("作成");
		submit.type = "submit";
		form.append(name.label, mode.label, slot, submit);
		panel.append(form);
		const feedback = notice(panel);
		form.onsubmit = event => event.preventDefault();
		const widget = await captcha(slot, submit, feedback);
		if (!widget || current !== generation) return;
		form.onsubmit = async event => {
			event.preventDefault();
			if (!widget.token() || submit.disabled) return;
			widget.begin();
			feedback.textContent = "";
			try {
				await api("/api/worlds", "POST", { name: name.field.value, gameMode: mode.field.value, turnstileToken: widget.token() });
				await refreshWorlds(name.field.value);
				if (current === generation) {
					widget.reset();
					go("worlds");
				}
			} catch (error) {
				feedback.textContent = error instanceof APIError && error.status === 400
					? "名前は半角英小文字・数字で始まる1〜32文字にしてください（- と _ も使えます）" : message(error);
			} finally { widget.reset(); }
		};
	}

	function updateUser() {
		userDisplay.replaceChildren();
		if (me?.user) {
			const avatar = element("span", Array.from(me.user.name || me.user.email)[0].toUpperCase());
			avatar.className = "avatar";
			const identity = element("div");
			identity.append(element("strong", me.user.name), element("small", me.user.email));
			userDisplay.append(avatar, identity);
		}
	}

	function render() {
		generation++;
		disposeCaptcha?.();
		disposeCaptcha = undefined;
		panel.replaceChildren();
		panel.className = screen === "worlds" ? "panel wide" : screen === "textures" ? "panel textures" : "panel";
		// Restart only the panel animation; the background element stays mounted.
		panel.classList.remove("swap");
		void panel.offsetWidth;
		panel.classList.add("swap");

		const titles: Record<Screen, string> = {
			loading: "読み込み中…", error: "読み込みエラー", login: "ログイン", textures: "テクスチャをインストール", menu: "メニュー",
			worlds: "マルチプレイ", members: `${selected ?? ""} のメンバー`, create: "ワールドを作成",
		};
		const title = heading(titles[screen], screen === "worlds" ? "menu" : screen === "members" || screen === "create" ? "worlds" : undefined);
		status.textContent = titles[screen];
		switch (screen) {
			case "error":
				notice(panel).textContent = startupError;
				panel.append(button("再読み込み", "gray", () => { void initialize(); }));
				break;
			case "login": void login(panel, generation); break;
			case "textures": textures(); break;
			case "menu": menu(); break;
			case "worlds": worldList(); break;
			case "members": {
				const world = worlds?.find(world => world.name === selected && world.role === "operator");
				if (world) void members(world, generation);
				break;
			}
			case "create": void createWorld(generation); break;
		}
		title.focus({ preventScroll: true });
	}

	async function readPack() {
		layout = await loadLayout();
		packStorageError = "";
		try { setPack(await loadInstalledPack(layout.names)); }
		catch (error) {
			setPack(undefined);
			packStorageError = message(error);
		}
	}

	async function initialize() {
		go("loading");
		const selection = readPack().then(() => null, error => ({ error }));
		try {
			me = await api<Me>("/api/me");
			updateUser();
			if (hasPlaySession(me)) {
				const result = await selection;
				if (result) throw result.error;
			}
			const next = titleScreen(me, Boolean(pack));
			if (next === "menu") openMenu();
			else go(next);
		} catch (error) {
			startupError = message(error);
			go("error");
		}
	}
	void initialize();
	void startBackground();
}

const redirect = gameRedirect(location.search);
if (redirect !== null) location.replace(redirect + location.hash);
else start();
