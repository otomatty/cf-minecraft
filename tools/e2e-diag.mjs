import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function shouldDiagnoseRunFailure(err) {
	let timeout = false;
	// Inspect at most five errors, including the original, even for cyclic causes.
	for (let depth = 0; err && depth < 5; depth++, err = err.cause) {
		if (err.diagnosed) return false;
		timeout ||= err.name === "TimeoutError" || /timed out|Navigation timeout of \d+ ms exceeded|Waiting failed: \d+ms exceeded/i.test(err.message);
	}
	return timeout;
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

const crashWatches = new WeakMap();

/** Record renderer crashes for later diagnostics. `onCrash` receives a short label. */
export async function watchForCrash(page, onCrash) {
	const existing = crashWatches.get(page);
	if (existing) {
		await existing.ready;
		return;
	}
	const record = { crashed: false, pageErrors: [], targetCrashed: [], ready: null };
	crashWatches.set(page, record);
	page.on("error", (error) => {
		record.crashed = true;
		const message = error instanceof Error ? error.message : String(error);
		record.pageErrors.push(message);
		onCrash?.(`page error: ${message}`);
	});
	record.ready = (async () => {
		try {
			const session = await page.target().createCDPSession();
			await session.send("Inspector.enable");
			session.on("Inspector.targetCrashed", (params) => {
				record.crashed = true;
				record.targetCrashed.push(params ?? {});
				onCrash?.("Inspector.targetCrashed");
			});
		} catch (error) {
			record.inspectorError = error instanceof Error ? error.message : String(error);
		}
	})();
	await record.ready;
}

function crashRecord(page) {
	return crashWatches.get(page) ?? null;
}

export async function diagnose(browser, page, label, { edge, shots }) {
	// Individual deadlines (including cleanup and the sampling gap) total ~47s.
	const file = join(shots, `diag-${safeFilename(label)}`);
	const record = crashRecord(page);
	const result = { crashed: record?.crashed === true };
	if (result.crashed) {
		result.crash = {
			pageErrors: record.pageErrors,
			targetCrashed: record.targetCrashed,
		};
	}
	if (record?.inspectorError) result.crashWatchError = record.inspectorError;
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

	// Capture before opening a fresh tab, which changes focus and releases pointer lock.
	// Raw CDP avoids Puppeteer's screenshot lock, which can delay page.close()
	// after a bounded page.screenshot() has already returned a timeout.
	let screenshotSession;
	let screenshotExpired = false;
	try {
		const ready = await bounded(async () => {
			screenshotSession = await page.target().createCDPSession();
			if (screenshotExpired) {
				await bounded(() => screenshotSession.detach(), 1000);
				return "screenshot session arrived after deadline";
			}
			return true;
		}, 3000);
		if (ready === true) {
			// CDPSession.send's third argument is supported in puppeteer-core 25.16.0.
			const capture = await bounded(() => screenshotSession.send("Page.captureScreenshot", { format: "png" }, { timeout: 5000 }), 5000);
			result.screenshot = typeof capture === "string" ? capture : await bounded(async () => {
				await writeFile(`${file}.png`, Buffer.from(capture.data, "base64"));
				return `${file}.png`;
			}, 500);
		} else {
			result.screenshot = ready;
		}
	} finally {
		screenshotExpired = true;
		if (screenshotSession) result.screenshotSessionDetach = await bounded(async () => { await screenshotSession.detach(); return "detached"; }, 1000);
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
