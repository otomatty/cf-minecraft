/** Count queued and running requests; ties go to the lowest worker index. */
export function leastPendingWorker(queues: ReadonlyArray<{ readonly size: number }>): number {
	let selected = 0;
	for (let i = 1; i < queues.length; i++) {
		if (queues[i].size < queues[selected].size) selected = i;
	}
	return selected;
}

export function generationInFlightLimit(workerCount: number): number {
	return Math.min(32, Math.max(8, workerCount * 4));
}
