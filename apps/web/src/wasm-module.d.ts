// In the Worker bundle a .wasm import is the compiled module.
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
