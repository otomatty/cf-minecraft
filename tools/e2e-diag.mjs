import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function shouldDiagnoseRunFailure(err) {
	return !err.diagnosed && /timed out/i.test(err.message);
}

/** Return errors and deadlines as data; also catches synchronous throws. */
export async function bounded(operation, ms, timeoutValue = `timed out after ${ms}ms`) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise(resolve => { timer = setTimeout(() => resolve(timeoutValue), ms); }),
		]);
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		clearTimeout(timer);
	}
}

export function safeFilename(label) {
	return String(label).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "diagnostic";
}

export function summarizeTargets(targetInfos) {
	const counts = {};
	for (const { type, url } of targetInfos) {
		const tail = url.split("?")[0].split("/").pop() || "/";
		const key = `${type}: ${tail}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/** CPU seconds accumulated between samples, grouped by process type. */
export function processCpuDeltas(before, after) {
	const previous = new Map(before.map(p => [p.id, p]));
	const result = {};
	for (const p of after) {
		const group = result[p.type] ??= { count: 0, sampled: 0, cpuTimeDelta: 0 };
		group.count++;
		const old = previous.get(p.id);
		if (old?.type === p.type && p.cpuTime >= old.cpuTime) {
			group.sampled++;
			group.cpuTimeDelta += p.cpuTime - old.cpuTime;
		}
	}
	return result;
}

export async function diagnose(browser, page, label, { edge, shots }) {
	// Individual deadlines (including cleanup and the sampling gap) total ~43s.
	const file = join(shots, `diag-${safeFilename(label)}`);
	const result = {};
	result.page = await bounded(() => page.evaluate(() => {
		const s = window.__mc?.stats?.();
		return {
			readyState: document.readyState,
			url: location.href,
			mc: !!window.__mc,
			error: window.__mc?.error ?? null,
			stats: s ? {
				joined: s.joined, chunks: s.chunks, sections: s.sections,
				meshQueue: s.meshQueue, lightQueue: s.lightQueue, gameMode: s.gameMode,
			} : null,
		};
	}), 5000, "no response");

	// Allow browser-level CDP calls 3s each on busy CI machines.
	let session;
	let sessionExpired = false;
	const connected = await bounded(async () => {
		session = await browser.target().createCDPSession();
		if (sessionExpired) {
			await bounded(() => session.detach(), 1000);
			return "session arrived after deadline";
		}
		return true;
	}, 3000);
	sessionExpired = true;
	if (connected === true) {
		result.targets = await bounded(async () => summarizeTargets((await session.send("Target.getTargets")).targetInfos), 3000);
		const before = await bounded(() => session.send("SystemInfo.getProcessInfo"), 3000);
		await delay(2000);
		const after = await bounded(() => session.send("SystemInfo.getProcessInfo"), 3000);
		result.processes = typeof before === "string" || typeof after === "string"
			? `first sample: ${typeof before === "string" ? before : "ok"}; second sample: ${typeof after === "string" ? after : "ok"}`
			: await bounded(() => processCpuDeltas(before.processInfo, after.processInfo), 750);
	} else {
		result.targets = connected;
		result.processes = connected;
	}

	let fresh;
	let freshExpired = false;
	try {
		result.freshTab = await bounded(async () => {
			fresh = await browser.newPage();
			if (freshExpired) {
				await bounded(() => fresh.close(), 1000);
				return "tab arrived after deadline";
			}
			await fresh.goto(`${edge}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
			return fresh.evaluate(() => document.readyState);
		}, 15000);
	} finally {
		freshExpired = true;
		if (fresh) result.freshTabClose = await bounded(async () => { await fresh.close(); return "closed"; }, 1000);
	}
	result.screenshot = await bounded(async () => {
		await page.screenshot({ path: `${file}.png` });
		return `${file}.png`;
	}, 5000);
	if (connected === true) result.sessionDetach = await bounded(async () => { await session.detach(); return "detached"; }, 1000);
	const saved = await bounded(async () => {
		await mkdir(shots, { recursive: true });
		await writeFile(`${file}.json`, `${JSON.stringify(result, null, 2)}\n`);
		return true;
	}, 500);
	if (saved !== true) result.writeError = saved;
	console.log(`DIAG ${String(label).replace(/[\r\n]/g, " ")} ${JSON.stringify(result)}`);
	return result;
}
