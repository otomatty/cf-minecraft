//! C ABI for the client side: a mirror of the chunks the server has sent,
//! packet encoding/decoding, section meshing and block ray casts.
//!
//! Same conventions as `wasm-server`: no imports, byte results go to an
//! internal buffer (`client_out_ptr`), mesh vertices to a second one
//! (`client_mesh_ptr`).

use std::cell::UnsafeCell;
use std::collections::{BTreeMap, BTreeSet};

use mesher::{padded_index, PADDED_LEN};
use protocol::{C2S, PROTOCOL_VERSION, S2C};
use world::io::Reader;
use world::{blocks, Chunk, World, HEIGHT, MIN_Y, SECTIONS};

/// Stand-in for blocks of chunks that have not arrived yet: treated as solid
/// so no faces are built against the unknown, then re-meshed on arrival.
const UNKNOWN: u16 = blocks::STONE;

struct State {
    world: World,
    /// Sections whose mesh is stale: (chunk x, section index, chunk z).
    dirty: BTreeSet<(i32, i32, i32)>,
    unloaded: Vec<(i32, i32)>,
    light_pending: BTreeSet<(i32, i32)>,
    external_light: bool,
    light_generations: BTreeMap<(i32, i32), (u32, u32)>,
    light_exports: Option<BTreeSet<(i32, usize, i32)>>,
    seed: i64,
    spawn: [f64; 3],
    view_distance: u32,
    game_time: i64,
    day_time: i64,
    out: Vec<u8>,
    padded: Vec<u16>,
    padded_lights: Vec<u8>,
    player: physics::Player,
    flying: bool,
}

struct Global(UnsafeCell<Option<State>>);
// SAFETY: a WebAssembly instance without threads is only ever entered from one thread.
unsafe impl Sync for Global {}
static STATE: Global = Global(UnsafeCell::new(None));

struct MeshOutput(UnsafeCell<Vec<u32>>);
// SAFETY: each instance is entered by only one thread.
unsafe impl Sync for MeshOutput {}
static MESH_OUTPUT: MeshOutput = MeshOutput(UnsafeCell::new(Vec::new()));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    // SAFETY: single-threaded, and no exported function re-enters another.
    unsafe {
        (*STATE.0.get())
            .as_mut()
            .expect("client_new must be called first")
    }
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
pub extern "C" fn client_new() {
    let st = State {
        world: World::with_lighting(true),
        dirty: BTreeSet::new(),
        unloaded: Vec::new(),
        light_pending: BTreeSet::new(),
        external_light: false,
        light_generations: BTreeMap::new(),
        light_exports: None,
        seed: 0,
        spawn: [0.0; 3],
        view_distance: 0,
        game_time: 0,
        day_time: 0,
        out: Vec::new(),
        padded: vec![blocks::AIR; PADDED_LEN],
        padded_lights: Vec::new(),
        player: physics::Player::default(),
        flying: true,
    };
    let mut st = st;
    st.world.track_light_changes();
    // SAFETY: single-threaded.
    unsafe { *STATE.0.get() = Some(st) };
}

/// Discards the mirror and queues all old chunk meshes for removal.
#[no_mangle]
pub extern "C" fn client_reset_world() {
    let st = state();
    if st.light_exports.is_none() {
        st.unloaded.extend(st.world.chunks.keys().copied());
    }
    st.world.chunks.clear();
    st.dirty.clear();
    st.light_pending.clear();
    st.light_generations.clear();
    if let Some(exports) = &mut st.light_exports {
        exports.clear();
    }
    st.world.take_light_changes().for_each(drop);
}

#[no_mangle]
pub extern "C" fn client_out_ptr() -> *const u8 {
    state().out.as_ptr()
}

#[no_mangle]
pub extern "C" fn client_mesh_ptr() -> *const u32 {
    unsafe { (&*MESH_OUTPUT.0.get()).as_ptr() }
}

fn mark_chunk_dirty(st: &mut State, cx: i32, cz: i32) {
    if st.light_exports.is_some() {
        return;
    }
    if let Some(chunk) = st.world.chunks.get(&(cx, cz)) {
        for (i, section) in chunk.sections.iter().enumerate() {
            if !section.is_empty() {
                st.dirty.insert((cx, i as i32, cz));
            }
        }
    }
}

/// Handles one server packet. Returns the packet id, or 0xFFFF_FFFF when the
/// packet was malformed and ignored.
///
/// # Safety
/// `ptr..ptr+len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn client_packet(ptr: *const u8, len: usize) -> u32 {
    let bytes = input(ptr, len);
    let st = state();
    let Ok(packet) = S2C::decode(bytes) else {
        return u32::MAX;
    };
    match packet {
        S2C::Welcome {
            seed,
            game_time,
            spawn,
            view_distance,
        } => {
            st.seed = seed;
            st.game_time = game_time;
            st.spawn = spawn;
            st.view_distance = view_distance as u32;
        }
        S2C::ChunkData { cx, cz, data } => {
            let Ok(chunk) = Chunk::read(cx, cz, &mut Reader::new(&data)) else {
                return u32::MAX;
            };
            st.light_generations.remove(&(cx, cz));
            if st.external_light {
                st.world.chunks.insert((cx, cz), chunk);
            } else {
                st.world.insert_chunk_unlit(chunk);
            }
            st.light_pending.insert((cx, cz));
            mark_chunk_dirty(st, cx, cz);
            // Border faces of the neighbours can now be culled.
            for (dx, dz) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                mark_chunk_dirty(st, cx + dx, cz + dz);
            }
        }
        S2C::UnloadChunk { cx, cz } => {
            st.light_pending.remove(&(cx, cz));
            st.light_generations.remove(&(cx, cz));
            let removed = if st.external_light {
                st.world.chunks.remove(&(cx, cz))
            } else {
                st.world.remove_chunk(cx, cz)
            };
            if removed.is_some() && st.light_exports.is_none() {
                st.unloaded.push((cx, cz));
            }
        }
        S2C::BlockUpdate {
            x,
            y,
            z,
            state: block,
        } => {
            set_block(st, x, y, z, block);
        }
        S2C::TimeUpdate {
            game_time,
            day_time,
        } => {
            st.game_time = game_time;
            st.day_time = day_time;
        }
    }
    mark_light_dirty(st);
    bytes[0] as u32
}

fn set_block(st: &mut State, x: i32, y: i32, z: i32, block: u16) -> bool {
    if !blocks::is_valid(block) {
        return false;
    }
    let old = if st.external_light {
        st.world
            .chunks
            .get_mut(&(x >> 4, z >> 4))
            .and_then(|c| c.set((x & 15) as usize, y, (z & 15) as usize, block))
    } else {
        st.world.set_block(x, y, z, block)
    };
    match old {
        Some(old) if old != block => {
            // Faces and ambient occlusion of every block touching this one,
            // including diagonally, may change: mark each section in reach.
            if st.light_exports.is_none() {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        for dx in -1..=1 {
                            let (nx, ny, nz) = (x + dx, y + dy, z + dz);
                            if let Some(s) = world::section_index(ny) {
                                st.dirty.insert((nx >> 4, s as i32, nz >> 4));
                            }
                        }
                    }
                }
            }
            mark_light_dirty(st);
            true
        }
        _ => false,
    }
}

/// Applies a block change locally before the server confirms it.
#[no_mangle]
pub extern "C" fn client_predict_block(x: i32, y: i32, z: i32, block: u32) -> u32 {
    set_block(state(), x, y, z, block as u16) as u32
}

#[no_mangle]
pub extern "C" fn client_seed() -> i64 {
    state().seed
}

#[no_mangle]
pub extern "C" fn client_spawn(axis: u32) -> f64 {
    state().spawn[(axis as usize).min(2)]
}

#[no_mangle]
pub extern "C" fn client_view_distance() -> u32 {
    state().view_distance
}

#[no_mangle]
pub extern "C" fn client_game_time() -> i64 {
    state().game_time
}

#[no_mangle]
pub extern "C" fn client_day_time() -> i64 {
    state().day_time
}

#[no_mangle]
pub extern "C" fn client_chunk_count() -> u32 {
    state().world.chunks.len() as u32
}

#[no_mangle]
pub extern "C" fn client_dirty_count() -> u32 {
    state().dirty.len() as u32
}

fn mark_light_dirty(st: &mut State) {
    let changes: Vec<_> = st.world.take_light_changes().collect();
    if let Some(exports) = &mut st.light_exports {
        exports.extend(changes);
        return;
    }
    for (cx, sy, cz) in changes {
        dirty_light_section(st, cx, sy, cz);
    }
}
fn dirty_light_section(st: &mut State, cx: i32, sy: usize, cz: i32) {
    if st.light_exports.is_some() {
        return;
    }
    for dz in -1..=1 {
        for dx in -1..=1 {
            for dy in -1..=1 {
                let s = sy as i32 + dy;
                if (0..SECTIONS as i32).contains(&s)
                    && st
                        .world
                        .chunks
                        .get(&(cx + dx, cz + dz))
                        .is_some_and(|c| !c.sections[s as usize].is_empty())
                {
                    st.dirty.insert((cx + dx, s, cz + dz));
                }
            }
        }
    }
}
/// External mode never runs initial or incremental lighting on this instance.
/// Switching back invalidates derived data and queues a budgeted rebuild.
#[no_mangle]
pub extern "C" fn client_external_light(enabled: u32) {
    let st = state();
    st.external_light = enabled != 0;
    st.light_pending.extend(st.world.chunks.keys().copied());
    for chunk in st.world.chunks.values_mut() {
        chunk.lighting = None;
    }
    for value in st.light_generations.values_mut() {
        value.1 = 0;
    }
    st.world.take_light_changes().for_each(drop);
}
#[no_mangle]
pub extern "C" fn client_light_generation(cx: i32, cz: i32, generation: u32) {
    state().light_generations.insert((cx, cz), (generation, 0));
}
#[no_mangle]
pub extern "C" fn client_light_export_mode() {
    let st = state();
    st.light_exports = Some(Default::default());
    // This instance only produces light updates; it has no renderer to drain these.
    st.dirty.clear();
    st.unloaded.clear();
}

// Wire record: cx, sy, cz, generation (four LE u32s), then 2048 sky
// and 2048 block packed nibble bytes. One batch can contain many chunks.
pub const LIGHT_RECORD_BYTES: usize = 16 + 4096;
fn write_nibbles(out: &mut Vec<u8>, values: &world::light::Nibbles) {
    match values {
        world::light::Nibbles::Uniform(v) => out.resize(out.len() + 2048, v * 17),
        world::light::Nibbles::Packed(a) => out.extend_from_slice(a.as_ref()),
    }
}
fn read_nibbles(bytes: &[u8]) -> world::light::Nibbles {
    let v = bytes[0] & 15;
    if bytes.iter().all(|&b| b == v * 17) {
        world::light::Nibbles::Uniform(v)
    } else {
        world::light::Nibbles::Packed(Box::new(bytes.try_into().unwrap()))
    }
}
#[no_mangle]
pub extern "C" fn client_take_light_updates() -> usize {
    let st = state();
    st.out.clear();
    let changes = st
        .light_exports
        .as_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    for (cx, sy, cz) in changes {
        let Some(c) = st.world.chunks.get(&(cx, cz)) else {
            continue;
        };
        let Some(light) = &c.lighting else { continue };
        let Some(&(generation, _)) = st.light_generations.get(&(cx, cz)) else {
            continue;
        };
        for value in [cx as u32, sy as u32, cz as u32, generation] {
            st.out.extend_from_slice(&value.to_le_bytes());
        }
        write_nibbles(&mut st.out, &light.sections[sy].sky);
        write_nibbles(&mut st.out, &light.sections[sy].block);
    }
    st.out.len()
}
/// # Safety
/// ptr..ptr+len must be readable; input must not alias the client state.
#[no_mangle]
pub unsafe extern "C" fn client_apply_light_updates(ptr: *const u8, len: usize) -> usize {
    let bytes = input(ptr, len);
    if !len.is_multiple_of(LIGHT_RECORD_BYTES) {
        return 0;
    }
    let st = state();
    if !st.external_light {
        return 0;
    }
    let mut changes = Vec::new();
    for record in bytes.as_chunks::<LIGHT_RECORD_BYTES>().0 {
        let word = |i| u32::from_le_bytes(record[i..i + 4].try_into().unwrap());
        let (cx, sy, cz, generation) = (word(0) as i32, word(4) as usize, word(8) as i32, word(12));
        if sy >= SECTIONS {
            continue;
        }
        let Some(value) = st.light_generations.get_mut(&(cx, cz)) else {
            continue;
        };
        if value.0 != generation {
            continue;
        }
        let Some(chunk) = st.world.chunks.get_mut(&(cx, cz)) else {
            continue;
        };
        let light = chunk.lighting.get_or_insert_with(Default::default);
        light.sections[sy] = world::light::LightSection {
            sky: read_nibbles(&record[16..2064]),
            block: read_nibbles(&record[2064..]),
        };
        value.1 |= 1 << sy;
        if value.1 == (1 << SECTIONS) - 1 {
            st.light_pending.remove(&(cx, cz));
        }
        changes.push((cx, sy, cz));
    }
    let count = changes.len();
    // Reuse the same conservative mesh invalidation as locally computed light.
    for (cx, sy, cz) in changes {
        dirty_light_section(st, cx, sy, cz);
    }
    count
}

fn light_ready(st: &State, cx: i32, cz: i32) -> bool {
    (-1..=1).all(|dz| (-1..=1).all(|dx| !st.light_pending.contains(&(cx + dx, cz + dz))))
}
#[no_mangle]
pub extern "C" fn client_light_pending() -> usize {
    state().light_pending.len()
}
/// Process one nearest chunk. The host checks its clock between calls, so a
/// single chunk may overrun the frame deadline, but no second chunk starts.
#[no_mangle]
pub extern "C" fn client_light_step(cam_x: f64, cam_z: f64) -> u32 {
    let st = state();
    if st.external_light {
        return 0;
    }
    let distance = |&(x, z): &(i32, i32)| {
        let dx = (x * 16 + 8) as f64 - cam_x;
        let dz = (z * 16 + 8) as f64 - cam_z;
        dx * dx + dz * dz
    };
    let Some(key) = st
        .light_pending
        .iter()
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .copied()
    else {
        return 0;
    };
    st.light_pending.remove(&key);
    st.world.light_chunk(key.0, key.1);
    mark_light_dirty(st);
    1
}

/// Picks the stale section nearest to the camera. Output: `[cx][sy][cz]` as
/// i32 LE. Returns 0 when nothing is stale.
#[no_mangle]
pub extern "C" fn client_pop_dirty(cam_x: f64, cam_y: f64, cam_z: f64) -> u32 {
    let st = state();
    let world = &st.world;
    st.dirty
        .retain(|&(cx, _, cz)| world.chunks.contains_key(&(cx, cz)));
    let mut best: Option<(f64, (i32, i32, i32))> = None;
    for &key in &st.dirty {
        let (cx, sy, cz) = key;
        if !light_ready(st, cx, cz) {
            continue;
        }
        let dx = (cx * 16 + 8) as f64 - cam_x;
        let dy = (MIN_Y + sy * 16 + 8) as f64 - cam_y;
        let dz = (cz * 16 + 8) as f64 - cam_z;
        let d = dx * dx + dy * dy + dz * dz;
        if best.is_none_or(|(bd, _)| d < bd) {
            best = Some((d, key));
        }
    }
    let Some((_, key)) = best else { return 0 };
    st.dirty.remove(&key);
    st.out.clear();
    for v in [key.0, key.1, key.2] {
        st.out.extend_from_slice(&v.to_le_bytes());
    }
    1
}

/// Requeues work if a worker fails after taking it from the dirty set.
#[no_mangle]
pub extern "C" fn client_requeue_dirty(cx: i32, sy: i32, cz: i32) {
    let st = state();
    if st.light_exports.is_none() {
        st.dirty.insert((cx, sy, cz));
    }
}

#[no_mangle]
pub extern "C" fn client_is_dirty(cx: i32, sy: i32, cz: i32) -> u32 {
    (state().dirty.contains(&(cx, sy, cz)) || !light_ready(state(), cx, cz)) as u32
}

/// Copies the section and its border into the padded buffer; returns u16 count.
#[no_mangle]
pub extern "C" fn client_padded(cx: i32, sy: i32, cz: i32) -> usize {
    let st = state();
    if !(0..SECTIONS as i32).contains(&sy) {
        return 0;
    }
    let Some(center) = st.world.chunks.get(&(cx, cz)) else {
        return 0;
    };
    if center.sections[sy as usize].is_empty() {
        return 0;
    }

    // The 3x3 chunk columns around the section, fetched once.
    let mut columns: [Option<&Chunk>; 9] = [None; 9];
    for dz in -1..=1 {
        for dx in -1..=1 {
            columns[((dz + 1) * 3 + dx + 1) as usize] = st.world.chunks.get(&(cx + dx, cz + dz));
        }
    }
    let base_y = MIN_Y + sy * 16;
    for y in -1..=16 {
        let wy = base_y + y;
        let in_world = (MIN_Y..MIN_Y + HEIGHT).contains(&wy);
        for z in -1..=16i32 {
            for x in -1..=16i32 {
                let column = columns[(((z >> 4) + 1) * 3 + (x >> 4) + 1) as usize];
                let block = if !in_world {
                    blocks::AIR
                } else {
                    match column {
                        Some(c) => c.get((x & 15) as usize, wy, (z & 15) as usize),
                        None => UNKNOWN,
                    }
                };
                st.padded[padded_index(x, y, z)] = block;
            }
        }
    }
    PADDED_LEN
}

#[no_mangle]
pub extern "C" fn client_padded_ptr() -> *const u16 {
    state().padded.as_ptr()
}

/// Copies 18³ sky/block levels (one byte each) in `padded_index` order.
/// Returns 0 while lighting is disabled. Otherwise missing chunks and below-world
/// cells are dark; above the world sky is 15.
#[no_mangle]
pub extern "C" fn client_padded_light(cx: i32, sy: i32, cz: i32) -> usize {
    let st = state();
    if !st.world.lighting_enabled()
        || !(0..SECTIONS as i32).contains(&sy)
        || !st.world.chunks.contains_key(&(cx, cz))
    {
        return 0;
    }
    st.padded_lights.resize(PADDED_LEN * 2, 0);
    let columns: [Option<&world::light::ChunkLighting>; 9] = std::array::from_fn(|i| {
        st.world
            .chunks
            .get(&(cx + i as i32 % 3 - 1, cz + i as i32 / 3 - 1))
            .and_then(|c| c.lighting.as_deref())
    });
    for y in -1..=16 {
        let wy = MIN_Y + sy * 16 + y;
        for z in -1..=16i32 {
            for x in -1..=16i32 {
                let i = padded_index(x, y, z);
                let light = columns[(((z >> 4) + 1) * 3 + (x >> 4) + 1) as usize];
                let (sky, block) = if let (Some(s), Some(light)) = (world::section_index(wy), light)
                {
                    let idx = world::Section::index(
                        (x & 15) as usize,
                        (wy & 15) as usize,
                        (z & 15) as usize,
                    );
                    (
                        light.sections[s].sky.get(idx),
                        light.sections[s].block.get(idx),
                    )
                } else {
                    ((wy >= MIN_Y + HEIGHT) as u8 * 15, 0)
                };
                st.padded_lights[i] = sky;
                st.padded_lights[PADDED_LEN + i] = block;
            }
        }
    }
    PADDED_LEN
}
#[no_mangle]
pub extern "C" fn client_padded_sky_ptr() -> *const u8 {
    state().padded_lights.as_ptr()
}
#[no_mangle]
pub extern "C" fn client_padded_block_ptr() -> *const u8 {
    state().padded_lights.as_ptr().wrapping_add(PADDED_LEN)
}

/// Meshes padded u16 block data without requiring client_new or a world.
/// Invalid lengths produce an empty mesh, like an empty section.
///
/// # Safety
/// For PADDED_LEN elements, ptr must point to that many readable, aligned u16s.
/// If both light pointers are non-null, each must contain PADDED_LEN readable bytes
/// with levels in 0..=15. A null light pointer selects the daylight fallback.
#[no_mangle]
pub unsafe extern "C" fn mesh_padded(
    ptr: *const u16,
    len: usize,
    sky: *const u8,
    block: *const u8,
) -> u32 {
    let mesh = &mut *MESH_OUTPUT.0.get();
    mesh.clear();
    if len != PADDED_LEN {
        return 0;
    }
    let light = if sky.is_null() || block.is_null() {
        None
    } else {
        Some((
            std::slice::from_raw_parts(sky, PADDED_LEN),
            std::slice::from_raw_parts(block, PADDED_LEN),
        ))
    };
    mesher::mesh_section_lit(std::slice::from_raw_parts(ptr, len), light, mesh)
}

/// Meshes one section into the mesh buffer and returns the quad count.
#[no_mangle]
pub extern "C" fn client_mesh(cx: i32, sy: i32, cz: i32) -> u32 {
    let len = client_padded(cx, sy, cz);
    // SAFETY: the padded buffer remains valid throughout the call.
    let lights = client_padded_light(cx, sy, cz);
    let (sky, block) = if lights == PADDED_LEN {
        (client_padded_sky_ptr(), client_padded_block_ptr())
    } else {
        (std::ptr::null(), std::ptr::null())
    };
    unsafe { mesh_padded(client_padded_ptr(), len, sky, block) }
}

/// Output: repeated `[cx i32 LE][cz i32 LE]` of chunks removed since the last call.
#[no_mangle]
pub extern "C" fn client_take_unloaded() -> usize {
    let st = state();
    st.out.clear();
    for (cx, cz) in st.unloaded.drain(..) {
        st.out.extend_from_slice(&cx.to_le_bytes());
        st.out.extend_from_slice(&cz.to_le_bytes());
    }
    st.out.len()
}

/// Block at a position; 0xFFFF_FFFF when the chunk is not loaded.
#[no_mangle]
pub extern "C" fn client_get_block(x: i32, y: i32, z: i32) -> u32 {
    state()
        .world
        .get_block(x, y, z)
        .map_or(u32::MAX, |b| b as u32)
}

/// Walks the voxel grid along a ray and stops at the first non-air block.
/// Output on hit: `[x][y][z][face]` as i32 LE, where face is the side that was
/// entered (`Direction` order). Returns 1 on hit.
#[no_mangle]
pub extern "C" fn client_raycast(
    ox: f64,
    oy: f64,
    oz: f64,
    dx: f64,
    dy: f64,
    dz: f64,
    max: f64,
) -> u32 {
    let st = state();
    let origin = [ox, oy, oz];
    let dir = [dx, dy, dz];
    if dir.iter().all(|d| *d == 0.0) || !origin.iter().chain(dir.iter()).all(|v| v.is_finite()) {
        return 0;
    }
    let mut cell = [ox.floor() as i32, oy.floor() as i32, oz.floor() as i32];
    let mut step = [0i32; 3];
    let mut t_max = [f64::INFINITY; 3];
    let mut t_delta = [f64::INFINITY; 3];
    for a in 0..3 {
        if dir[a] > 0.0 {
            step[a] = 1;
            t_delta[a] = 1.0 / dir[a];
            t_max[a] = ((cell[a] + 1) as f64 - origin[a]) / dir[a];
        } else if dir[a] < 0.0 {
            step[a] = -1;
            t_delta[a] = -1.0 / dir[a];
            t_max[a] = (cell[a] as f64 - origin[a]) / dir[a];
        }
    }
    // Faces by axis and step direction: entering while moving +x means the west face, and so on.
    const FACE: [[i32; 2]; 3] = [[4, 5], [0, 1], [2, 3]];
    let mut face = -1i32;
    loop {
        if let Some(b) = st.world.get_block(cell[0], cell[1], cell[2]) {
            if b != blocks::AIR && face >= 0 {
                st.out.clear();
                for v in [cell[0], cell[1], cell[2], face] {
                    st.out.extend_from_slice(&v.to_le_bytes());
                }
                return 1;
            }
        }
        let a = if t_max[0] <= t_max[1] && t_max[0] <= t_max[2] {
            0
        } else if t_max[1] <= t_max[2] {
            1
        } else {
            2
        };
        if t_max[a] > max {
            return 0;
        }
        cell[a] += step[a];
        t_max[a] += t_delta[a];
        face = FACE[a][if step[a] > 0 { 0 } else { 1 }];
    }
}

fn emit(st: &mut State, bytes: Vec<u8>) -> usize {
    st.out = bytes;
    st.out.len()
}

#[no_mangle]
pub extern "C" fn client_enc_hello(view_distance: u32) -> usize {
    let p = C2S::Hello {
        protocol: PROTOCOL_VERSION,
        view_distance: view_distance.min(255) as u8,
    };
    emit(state(), p.encode())
}

#[no_mangle]
pub extern "C" fn client_enc_pos(x: f64, y: f64, z: f64, yaw: f32, pitch: f32) -> usize {
    emit(
        state(),
        C2S::PlayerPos {
            x,
            y,
            z,
            yaw,
            pitch,
        }
        .encode(),
    )
}

#[no_mangle]
pub extern "C" fn client_enc_set_block(x: i32, y: i32, z: i32, block: u32) -> usize {
    emit(
        state(),
        C2S::SetBlock {
            x,
            y,
            z,
            state: block.min(u16::MAX as u32) as u16,
        }
        .encode(),
    )
}

/// Output: newline-separated texture names in atlas layer order.
#[no_mangle]
pub extern "C" fn client_texture_names() -> usize {
    emit(state(), blocks::TEXTURES.join("\n").into_bytes())
}

/// Output: newline-separated block names, line number = block id.
#[no_mangle]
pub extern "C" fn client_block_names() -> usize {
    let names: Vec<&str> = (0..blocks::COUNT).map(|b| blocks::info(b).name).collect();
    emit(state(), names.join("\n").into_bytes())
}

/// Reset prediction after spawn or a debug camera teleport. Coordinates are feet.
#[no_mangle]
pub extern "C" fn client_player_reset(x: f64, y: f64, z: f64) {
    let st = state();
    st.player = physics::Player::new([x, y, z]);
    st.flying = true;
}

struct Collisions<'a>(&'a World);
impl physics::CollisionWorld for Collisions<'_> {
    fn collision_box(&self, x: i32, y: i32, z: i32) -> Option<physics::Aabb> {
        // Unknown chunks are solid: never predict a fall into unloaded terrain.
        self.0
            .get_block(x, y, z)
            .is_none_or(blocks::is_opaque)
            .then(|| physics::Aabb::block(x, y, z))
    }
}

/// Toggle only when the player can safely start walking. A debug teleport or
/// a placed block may leave the player inside terrain; flight lets them escape.
#[no_mangle]
pub extern "C" fn client_player_toggle_flight() -> u32 {
    let st = state();
    if !st.flying || st.player.is_clear(&Collisions(&st.world)) {
        st.flying = !st.flying;
    }
    u32::from(st.flying)
}

/// One 50ms tick. Flags: jump=1, sprint=2, sneak=4. Output is six f64 LE
/// values (feet xyz, velocity xyz), followed by on_ground and flying as u8.
#[no_mangle]
pub extern "C" fn client_player_tick(forward: f32, strafe: f32, yaw: f32, flags: u32) {
    let st = state();
    st.player.tick(
        physics::Input {
            forward,
            strafe,
            yaw,
            jump: flags & 1 != 0,
            sprint: flags & 2 != 0,
            sneak: flags & 4 != 0,
            flying: st.flying,
        },
        &Collisions(&st.world),
    );
    st.out.clear();
    for v in st.player.position.into_iter().chain(st.player.velocity) {
        st.out.extend_from_slice(&v.to_le_bytes());
    }
    st.out.push(u8::from(st.player.on_ground));
    st.out.push(u8::from(st.flying));
}

#[cfg(test)]
mod tests {
    use super::*;

    static CLIENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn receive(chunk: &Chunk) {
        let packet = S2C::ChunkData {
            cx: chunk.cx,
            cz: chunk.cz,
            data: chunk.to_bytes(),
        }
        .encode();
        assert_ne!(
            unsafe { client_packet(packet.as_ptr(), packet.len()) },
            u32::MAX
        );
    }

    #[test]
    fn light_export_mode_never_retains_render_work() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        // Enabling export mode also discards any previously queued render work.
        let mut chunk = Chunk::empty(0, 0);
        chunk.set(8, 0, 8, blocks::STONE);
        receive(&chunk);
        client_reset_world();
        assert!(!state().unloaded.is_empty());
        receive(&chunk);
        assert!(!state().dirty.is_empty());
        client_light_export_mode();
        client_reset_world();

        let assert_no_render_work = || {
            assert!(state().dirty.is_empty());
            assert!(state().unloaded.is_empty());
        };
        assert_no_render_work();
        for generation in 1..=8 {
            receive(&chunk);
            client_light_generation(0, 0, generation);
            assert_eq!(client_light_pending(), 1);
            assert_no_render_work();
            assert_eq!(client_predict_block(8, 0, 8, blocks::LAMP_BLOCK as u32), 1);
            assert_no_render_work();
            assert_eq!(client_light_step(0.0, 0.0), 1);
            assert_eq!(client_light_pending(), 0);
            assert_eq!(state().world.block_light(9, 0, 8), 14);
            assert_eq!(client_take_light_updates(), SECTIONS * LIGHT_RECORD_BYTES);
            assert_eq!(client_take_light_updates(), 0);
            assert_no_render_work();

            client_requeue_dirty(0, 4, 0);
            dirty_light_section(state(), 0, 4, 0);
            assert_no_render_work();
            let edit = S2C::BlockUpdate {
                x: 8,
                y: 0,
                z: 8,
                state: blocks::AIR,
            }
            .encode();
            unsafe {
                client_packet(edit.as_ptr(), edit.len());
            }
            assert_eq!(state().world.block_light(9, 0, 8), 0);
            assert!(client_take_light_updates() > 0);
            assert_no_render_work();

            let unload = S2C::UnloadChunk { cx: 0, cz: 0 }.encode();
            unsafe {
                client_packet(unload.as_ptr(), unload.len());
            }
            assert_eq!(client_light_pending(), 0);
            assert_no_render_work();
            receive(&chunk);
            client_light_generation(0, 0, generation + 8);
            assert_eq!(client_light_step(0.0, 0.0), 1);
            assert!(client_take_light_updates() > 0);
            assert_no_render_work();
            client_reset_world();
            assert_eq!(client_light_pending(), 0);
            assert_eq!(client_take_light_updates(), 0);
            assert!(state().world.chunks.is_empty());
            assert_no_render_work();
        }

        // Normal clients still queue meshes and removals for their renderer.
        client_new();
        receive(&chunk);
        assert!(!state().dirty.is_empty());
        let unload = S2C::UnloadChunk { cx: 0, cz: 0 }.encode();
        unsafe {
            client_packet(unload.as_ptr(), unload.len());
        }
        assert_eq!(state().unloaded, vec![(0, 0)]);
        receive(&chunk);
        client_reset_world();
        assert_eq!(state().unloaded, vec![(0, 0), (0, 0)]);
    }

    #[test]
    fn external_light_matches_computed_world_and_rejects_old_generations() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        client_light_export_mode();
        let mut left = Chunk::empty(-1, 0);
        left.set(15, 0, 8, blocks::LAMP_BLOCK);
        let mut center = Chunk::empty(0, 0);
        for x in 0..16 {
            for z in 0..16 {
                center.set(x, 1, z, blocks::STONE);
            }
        }
        for (c, generation) in [(&left, 7), (&center, 8)] {
            receive(c);
            client_light_generation(c.cx, c.cz, generation);
        }
        while client_light_step(0.0, 0.0) != 0 {}
        let expected: BTreeMap<_, _> = state()
            .world
            .chunks
            .iter()
            .map(|(key, c)| (*key, c.lighting.clone().unwrap()))
            .collect();
        let len = client_take_light_updates();
        let updates = state().out[..len].to_vec();
        assert_eq!(len, 2 * SECTIONS * LIGHT_RECORD_BYTES);
        client_new();
        client_external_light(1);
        for (c, generation) in [(&left, 7), (&center, 8)] {
            receive(c);
            client_light_generation(c.cx, c.cz, generation);
        }
        assert_eq!(client_light_step(0.0, 0.0), 0);
        assert!(state().world.chunks.values().all(|c| c.lighting.is_none()));
        assert_eq!(client_light_pending(), 2);
        assert_eq!(
            unsafe { client_apply_light_updates(updates.as_ptr(), updates.len()) },
            2 * SECTIONS
        );
        assert_eq!(client_light_pending(), 0);
        for (key, light) in &expected {
            assert_eq!(
                state().world.chunks[key]
                    .lighting
                    .as_ref()
                    .unwrap()
                    .sections,
                light.sections
            );
        }
        assert_eq!(client_is_dirty(0, 4, 0), 1);
        // A replacement must receive all of its own sections before becoming ready.
        receive(&center);
        client_light_generation(0, 0, 9);
        let old_center: Vec<_> = updates
            .as_chunks::<LIGHT_RECORD_BYTES>()
            .0
            .iter()
            .filter(|r| i32::from_le_bytes(r[0..4].try_into().unwrap()) == 0)
            .flatten()
            .copied()
            .collect();
        assert_eq!(
            unsafe { client_apply_light_updates(old_center.as_ptr(), old_center.len()) },
            0
        );
        assert!(state().world.chunks[&(0, 0)].lighting.is_none());
        assert_eq!(client_light_pending(), 1);
        let unload = S2C::UnloadChunk { cx: -1, cz: 0 }.encode();
        unsafe {
            client_packet(unload.as_ptr(), unload.len());
        }
        assert_eq!(
            unsafe { client_apply_light_updates(updates.as_ptr(), updates.len()) },
            0
        );
        // Editing externally supplied light never starts incremental lighting.
        assert_eq!(client_predict_block(0, 0, 8, blocks::LAMP_BLOCK as u32), 1);
        assert!(state().world.chunks[&(0, 0)].lighting.is_none());
        client_external_light(0);
        assert_eq!(client_light_pending(), 1);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert_eq!(state().world.block_light(0, 0, 8), 15);
    }

    #[test]
    fn deferred_chunks_match_rebuild_and_edits_dirty_neighbors() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        let mut left = Chunk::empty(0, 0);
        left.set(15, 0, 8, blocks::LAMP_BLOCK);
        let mut right = Chunk::empty(1, 0);
        right.set(0, 0, 7, blocks::STONE);
        receive(&right);
        receive(&left);
        assert_eq!(client_light_pending(), 2);
        assert!(state().world.chunks.values().all(|c| c.lighting.is_none()));
        assert_eq!(client_pop_dirty(0.0, 0.0, 0.0), 0);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert!(state().world.chunks[&(0, 0)].lighting.is_some());
        assert_eq!(client_light_pending(), 1);
        assert_eq!(client_pop_dirty(0.0, 0.0, 0.0), 0);
        assert_eq!(client_light_step(0.0, 0.0), 1);
        assert_eq!(client_light_step(0.0, 0.0), 0);
        let mut rebuilt = World::with_lighting(true);
        rebuilt.insert_chunk(right);
        rebuilt.insert_chunk(left);
        for (key, chunk) in &state().world.chunks {
            assert_eq!(chunk.lighting, rebuilt.chunks[key].lighting);
        }
        state().dirty.clear();
        assert_eq!(client_predict_block(15, 0, 8, blocks::AIR as u32), 1);
        assert_eq!(state().world.block_light(16, 0, 8), 0);
        assert_eq!(client_is_dirty(1, 4, 0), 1);
        assert_eq!(client_is_dirty(0, 4, 0), 1);
        state().dirty.clear();
        let packet = S2C::BlockUpdate {
            x: 15,
            y: 0,
            z: 8,
            state: blocks::LAMP_BLOCK,
        }
        .encode();
        unsafe {
            client_packet(packet.as_ptr(), packet.len());
        }
        assert_eq!(state().world.block_light(16, 0, 8), 14);
        assert_eq!(client_is_dirty(1, 4, 0), 1);
        client_reset_world();
        assert_eq!(client_light_pending(), 0);
    }

    #[test]
    fn padded_lighting_includes_neighbors_and_vertical_limits() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        client_new();
        assert!(state().world.lighting_enabled());
        state().world.set_lighting_enabled(false);
        assert_eq!(client_padded_light(0, 0, 0), 0);
        assert_eq!(state().padded_lights.capacity(), 0);
        state().world.set_lighting_enabled(true);
        let mut left = Chunk::empty(-1, 0);
        left.set(15, MIN_Y + 15, 8, blocks::LAMP_BLOCK);
        // Exercise the same decoding and insertion path as a real mirror.
        for c in [Chunk::empty(0, 0), left] {
            let packet = S2C::ChunkData {
                cx: c.cx,
                cz: c.cz,
                data: c.to_bytes(),
            }
            .encode();
            assert_ne!(
                unsafe { client_packet(packet.as_ptr(), packet.len()) },
                u32::MAX
            );
        }
        while client_light_step(0.0, 0.0) != 0 {}
        assert_eq!(client_padded_light(0, 0, 0), PADDED_LEN);
        let sky = unsafe { std::slice::from_raw_parts(client_padded_sky_ptr(), PADDED_LEN) };
        let block = unsafe { std::slice::from_raw_parts(client_padded_block_ptr(), PADDED_LEN) };
        for y in -1..=16 {
            for z in -1..=16 {
                for x in -1..=16 {
                    let i = padded_index(x, y, z);
                    assert_eq!(sky[i], state().world.sky_light(x, MIN_Y + y, z));
                    assert_eq!(block[i], state().world.block_light(x, MIN_Y + y, z));
                }
            }
        }
        assert_eq!(block[padded_index(-1, 15, 8)], 15);
        assert_eq!(block[padded_index(0, 15, 8)], 14);
        assert_eq!(block[padded_index(0, 16, 8)], 13);
        assert_eq!(sky[padded_index(0, -1, 8)], 0);
        assert_eq!(sky[padded_index(16, 0, 8)], 0);
        assert_eq!(client_padded_light(0, SECTIONS as i32 - 1, 0), PADDED_LEN);
        assert_eq!(state().padded_lights[padded_index(0, 16, 8)], 15);
        assert_eq!(client_padded_light(0, -1, 0), 0);
        assert_eq!(client_padded_light(1, 0, 0), 0);
        assert_eq!(
            client_predict_block(-1, MIN_Y + 15, 8, blocks::AIR as u32),
            1
        );
        assert_eq!(state().world.block_light(0, MIN_Y + 15, 8), 0);
    }

    #[test]
    fn split_meshing_matches_client_mesh() {
        let _guard = CLIENT_LOCK.lock().unwrap();
        // The mesh-only entry point works before client_new.
        let mut padded = vec![blocks::AIR; PADDED_LEN];
        padded[padded_index(0, 0, 0)] = blocks::STONE;
        assert_eq!(
            unsafe {
                mesh_padded(
                    padded.as_ptr(),
                    padded.len(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            6
        );
        client_new();
        let mut chunk = Chunk::empty(0, 0);
        for y in MIN_Y..MIN_Y + 32 {
            for z in 0..16 {
                for x in 0..16 {
                    if (x + z + y) % 3 != 0 {
                        chunk.set(x as usize, y, z as usize, blocks::STONE);
                    }
                }
            }
        }
        state().world.insert_chunk(chunk);
        assert!(state().world.lighting_enabled());
        assert!(state().world.chunks[&(0, 0)].lighting.is_some());
        assert_eq!(client_padded_light(0, 0, 0), PADDED_LEN);

        for (cx, sy, cz) in [(0, 0, 0), (0, 1, 0), (0, 2, 0), (1, 0, 0), (0, -1, 0)] {
            let quads = client_mesh(cx, sy, cz);
            let expected = unsafe {
                std::slice::from_raw_parts(
                    client_mesh_ptr(),
                    quads as usize * mesher::WORDS_PER_QUAD,
                )
            }
            .to_vec();
            let len = client_padded(cx, sy, cz);
            let actual = unsafe {
                mesh_padded(
                    client_padded_ptr(),
                    len,
                    client_padded_sky_ptr(),
                    client_padded_block_ptr(),
                )
            };
            assert_eq!(actual, quads);
            assert_eq!(
                unsafe {
                    std::slice::from_raw_parts(
                        client_mesh_ptr(),
                        actual as usize * mesher::WORDS_PER_QUAD,
                    )
                },
                expected
            );
        }
    }
}
