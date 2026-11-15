import clientWasmUrl from "../wasm/client.wasm?url";
import { ClientCore } from "./client-core.ts";
import { LightEngine, type LightReply, type LightRequest } from "./light-pool.ts";

const scope = self as unknown as {
	onmessage: ((event: MessageEvent<LightRequest>) => void) | null;
	postMessage(message: LightReply, transfer: Transferable[]): void;
};
const core = await ClientCore.load(clientWasmUrl);
core.exportLight();
const engine = new LightEngine(core, reply => scope.postMessage(reply, reply.type === "light" ? [reply.updates.buffer] : []), run => setTimeout(run, 0));
scope.onmessage = ({ data }) => engine.handle(data);
scope.postMessage({ type: "ready" }, []);
