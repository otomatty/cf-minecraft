// In the browser bundle .wasm files are imported as URLs (`?url`).
declare module "*.wasm?url" {
	const url: string;
	export default url;
}
