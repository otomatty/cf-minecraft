//! C ABI around `sim::Server`, compiled to WebAssembly.
//!
//! One module instance holds one server. The module has no imports: the host
//! (browser worker or Durable Object) only moves bytes in and out.
//!
//! Functions that produce bytes write them to an internal buffer and return
//! the length; `server_out_ptr` gives its address. The buffer is valid until
//! the next call into the module.

use std::cell::UnsafeCell;

use sim::Server;
use worldgen::{Generator, TerrainGenerator};

struct State {
    server: Option<Server>,
    out: Vec<u8>,
    gen_out: Vec<u8>,
    terrain: Option<(i64, TerrainGenerator)>,
}

struct Global(UnsafeCell<State>);
// SAFETY: a WebAssembly instance without threads is only ever entered from one thread.
unsafe impl Sync for Global {}

static STATE: Global = Global(UnsafeCell::new(State {
    server: None,
    out: Vec::new(),
    gen_out: Vec::new(),
    terrain: None,
}));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    // SAFETY: single-threaded, and no exported function re-enters another.
    unsafe { &mut *STATE.0.get() }
}

fn server() -> &'static mut Server {
    state()
        .server
        .as_mut()
        .expect("server_new must be called first")
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

#[no_mangle]
pub extern "C" fn mc_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `mc_alloc(len)` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn mc_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn server_abi_version() -> u32 {
    7
}

#[no_mangle]
pub extern "C" fn server_new(seed: i64, generator: u32) {
    state().server = Some(Server::new(seed, Generator::from_id(generator)));
}

#[no_mangle]
pub extern "C" fn server_set_game_mode(mode: u32) {
    server().set_game_mode(if mode == 1 {
        sim::GameMode::Survival
    } else {
        sim::GameMode::Creative
    });
}
#[no_mangle]
pub extern "C" fn server_inventory_data(client: u32) -> usize {
    let st = state();
    st.out = st
        .server
        .as_ref()
        .expect("server")
        .inventory_data(client)
        .unwrap_or_default();
    st.out.len()
}

#[no_mangle]
pub extern "C" fn server_set_time(game_time: i64, day_time: i64) {
    server().set_time(game_time, day_time);
}

#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be readable.
pub unsafe extern "C" fn server_connect(
    client: u32,
    allow_teleport: u32,
    has_position: u32,
    x: f64,
    y: f64,
    z: f64,
    ptr: *const u8,
    len: usize,
) {
    server().connect_at(
        client,
        allow_teleport != 0,
        (has_position != 0).then_some([x, y, z]),
        (len != 0).then(|| input(ptr, len)),
    );
}

/// Output: last accepted feet [x, y, z] as f64 LE, or length 0 for an unknown id.
#[no_mangle]
pub extern "C" fn server_client_position(client: u32) -> usize {
    let st = state();
    st.out.clear();
    if let Some(position) = st.server.as_ref().expect("server").client_position(client) {
        for value in position {
            st.out.extend_from_slice(&value.to_le_bytes());
        }
    }
    st.out.len()
}

#[no_mangle]
pub extern "C" fn server_return_crafting(client: u32) {
    server().return_crafting(client);
}

#[no_mangle]
pub extern "C" fn server_disconnect(client: u32) {
    server().disconnect(client);
}

/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn server_packet(client: u32, ptr: *const u8, len: usize) {
    server().handle_packet(client, input(ptr, len));
}

#[no_mangle]
pub extern "C" fn server_tick() {
    server().tick();
}

#[no_mangle]
pub extern "C" fn server_out_ptr() -> *const u8 {
    state().out.as_ptr()
}

/// Output: repeated `[client u32 LE][len u32 LE][packet bytes]`.
#[no_mangle]
pub extern "C" fn server_take_outbox() -> usize {
    let st = state();
    let packets = st.server.as_mut().expect("server").take_outbox();
    st.out.clear();
    for (client, bytes) in packets {
        st.out.extend_from_slice(&client.to_le_bytes());
        st.out
            .extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        st.out.extend_from_slice(&bytes);
    }
    st.out.len()
}

/// Input: repeated `[cx i32 LE][cz i32 LE]`, the chunks present in storage.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn server_set_stored(ptr: *const u8, len: usize) {
    let bytes = input(ptr, len);
    let coords = bytes.as_chunks::<8>().0.iter().map(|c| {
        (
            i32::from_le_bytes(c[0..4].try_into().unwrap()),
            i32::from_le_bytes(c[4..8].try_into().unwrap()),
        )
    });
    server().set_stored(coords);
}

/// Output: repeated `[cx i32 LE][cz i32 LE]`, chunks to fetch from storage.
#[no_mangle]
pub extern "C" fn server_take_requests() -> usize {
    let st = state();
    let requests = st.server.as_mut().expect("server").take_requests();
    st.out.clear();
    for (cx, cz) in requests {
        st.out.extend_from_slice(&cx.to_le_bytes());
        st.out.extend_from_slice(&cz.to_le_bytes());
    }
    st.out.len()
}

/// Returns 1 when the stored bytes were accepted.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn server_load_chunk(cx: i32, cz: i32, ptr: *const u8, len: usize) -> u32 {
    server().load_chunk(cx, cz, input(ptr, len)) as u32
}

#[no_mangle]
pub extern "C" fn server_chunk_missing(cx: i32, cz: i32) {
    server().chunk_missing(cx, cz);
}

/// Output: `[cx i32 LE][cz i32 LE][chunk bytes]` for one chunk that needs
/// saving, or returns 0 when nothing is dirty.
#[no_mangle]
pub extern "C" fn server_take_dirty() -> usize {
    let st = state();
    st.out.clear();
    if let Some((cx, cz, bytes)) = st.server.as_mut().expect("server").take_dirty() {
        st.out.extend_from_slice(&cx.to_le_bytes());
        st.out.extend_from_slice(&cz.to_le_bytes());
        st.out.extend_from_slice(&bytes);
    }
    st.out.len()
}

#[no_mangle]
pub extern "C" fn server_dirty_chunks() -> u32 {
    server().dirty_chunks() as u32
}

#[no_mangle]
pub extern "C" fn server_state_hash() -> i64 {
    server().state_hash() as i64
}

#[no_mangle]
pub extern "C" fn server_game_time() -> i64 {
    server().game_time()
}

#[no_mangle]
pub extern "C" fn server_day_time() -> i64 {
    server().day_time()
}

#[no_mangle]
pub extern "C" fn server_loaded_chunks() -> u32 {
    server().loaded_chunks() as u32
}

#[no_mangle]
pub extern "C" fn server_client_count() -> u32 {
    server().client_count() as u32
}

/// Runs the scripted determinism scenario in a throwaway server and returns
/// its fingerprint. Does not touch the instance's own server.
#[no_mangle]
pub extern "C" fn server_run_scenario(seed: i64, ticks: u32) -> i64 {
    sim::scenario::run(seed, ticks) as i64
}

/// Storage operation (0–3: region access/decode, 4: encode chunk); returns -1 on invalid input. Uses server_out_ptr.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn storage_call(op: u32, ptr: *const u8, len: usize) -> i32 {
    match storage::call(op, input(ptr, len)) {
        Ok(out) => {
            state().out = out;
            state().out.len() as i32
        }
        Err(_) => -1,
    }
}

/// Pure noise probe, independent of the server and the legacy scenario hash.
#[no_mangle]
pub extern "C" fn server_noise_fingerprint(seed: i64) -> i64 {
    noise::fingerprint(seed) as i64
}

/// Pure terrain block probe, separate from the legacy scenario hash.
#[no_mangle]
pub extern "C" fn server_terrain_fingerprint(seed: i64) -> i64 {
    worldgen::terrain_fingerprint(seed) as i64
}

/// Output: UTF-8 name of the biome at the accepted player position.
#[no_mangle]
pub extern "C" fn server_client_biome(client: u32) -> usize {
    let st = state();
    let name = st.server.as_ref().expect("server").client_biome(client);
    st.out.clear();
    st.out.extend_from_slice(name.as_bytes());
    st.out.len()
}

/// Generation-only entry point: no server_new is required. Uses gen_out_ptr.
#[no_mangle]
pub extern "C" fn gen_chunk(seed: i64, generator: u32, cx: i32, cz: i32) -> usize {
    let st = state();
    let generator = Generator::from_id(generator);
    let chunk = if generator == Generator::Terrain {
        if st
            .terrain
            .as_ref()
            .is_none_or(|(cached, _)| *cached != seed)
        {
            st.terrain = Some((seed, TerrainGenerator::new(seed)));
        }
        st.terrain.as_ref().unwrap().1.generate(cx, cz)
    } else {
        worldgen::generate(generator, seed, cx, cz)
    };
    st.gen_out = chunk.to_bytes();
    st.gen_out.len()
}

#[no_mangle]
pub extern "C" fn gen_out_ptr() -> *const u8 {
    state().gen_out.as_ptr()
}

#[no_mangle]
pub extern "C" fn server_set_external_generation(max_in_flight: u32) {
    server().set_external_generation(max_in_flight as usize);
}

/// Output: repeated [cx i32 LE][cz i32 LE], using server_out_ptr.
#[no_mangle]
pub extern "C" fn server_take_generation_requests() -> usize {
    let st = state();
    let requests = st
        .server
        .as_mut()
        .expect("server")
        .take_generation_requests();
    st.out.clear();
    for (cx, cz) in requests {
        st.out.extend_from_slice(&cx.to_le_bytes());
        st.out.extend_from_slice(&cz.to_le_bytes());
    }
    st.out.len()
}

/// Returns 1 when the generated bytes were accepted.
///
/// # Safety
/// ptr..ptr+len must be readable.
#[no_mangle]
pub unsafe extern "C" fn server_deliver_generated(
    cx: i32,
    cz: i32,
    ptr: *const u8,
    len: usize,
) -> u32 {
    server().deliver_generated(cx, cz, input(ptr, len)) as u32
}

#[no_mangle]
pub extern "C" fn server_generate_now(cx: i32, cz: i32) {
    server().generate_now(cx, cz);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_without_server_matches_worldgen_and_switches_seed() {
        assert!(state().server.is_none());
        for seed in [2026, -71, 2026] {
            for generator in [Generator::Terrain, Generator::Flat, Generator::DebugHills] {
                let expected = worldgen::generate(generator, seed, -2, 3).to_bytes();
                let len = gen_chunk(seed, generator as u32, -2, 3);
                // SAFETY: the generation output remains valid until the next generation call.
                let bytes = unsafe { std::slice::from_raw_parts(gen_out_ptr(), len) };
                assert_eq!(bytes, expected);
                assert!(state().server.is_none());
            }
        }
        assert_eq!(state().terrain.as_ref().unwrap().0, 2026);
    }
}
