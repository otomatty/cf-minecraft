import type { WorkerEvent } from "./transport.ts";

/** The destination is durable; save the current world before allowing navigation. */
export async function finishWorldImport(
	request: { id: number; world: string },
	save: () => Promise<void>,
	persistence: { readonly retrying: boolean },
	post: (event: Extract<WorkerEvent, { type: "imported" }>) => void,
): Promise<void> {
	const message = `今のワールドの保存に失敗したため、移動できません。もう一度お試しください。読み込んだワールドは ${request.world} にあります`;
	try {
		await save();
	} catch (error) {
		throw new Error(message, { cause: error });
	}
	if (persistence.retrying) throw new Error(message);
	post({ type: "imported", id: request.id, world: request.world });
}
