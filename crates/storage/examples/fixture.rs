//! Native byte fixture for tools/storage.mjs (compared with the WASM C ABI).
use std::io::Write;
fn main() {
    let mut input = vec![0; 8 + storage::HEADER];
    input[4..8].copy_from_slice(&1023u32.to_le_bytes());
    input.extend((0..65536).map(|i| ((i * 31 + i / 17) % 256) as u8));
    std::io::stdout()
        .write_all(&storage::call(2, &input).unwrap())
        .unwrap();
}
